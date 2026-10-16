import { describe, expect, it } from 'vitest';
import { PROVIDER_TEMPLATES } from '../../../src/cli/commands/providers.js';
import { endpointSchema } from '../../../src/config/schema.js';
import {
  catalogEntry,
  endpointAuth,
  fillBaseUrl,
  kindForFlavor,
  modelsUrlFor,
  PROVIDER_CATALOG,
  templateFields,
} from '../../../src/providers/catalog.js';

describe('provider catalog', () => {
  it('has unique lowercase ids usable as model-ref prefixes', () => {
    const ids = PROVIDER_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect(ids.length).toBeGreaterThanOrEqual(75);
  });

  it('covers the major hosted, cloud and local providers', () => {
    for (const id of [
      'anthropic',
      'openai',
      'gemini',
      'vertex',
      'azure',
      'azure-foundry',
      'bedrock',
      'mistral',
      'deepseek',
      'xai',
      'groq',
      'cerebras',
      'together',
      'fireworks',
      'openrouter',
      'perplexity',
      'cohere',
      'nvidia',
      'huggingface',
      'moonshot',
      'zai',
      'zhipu',
      'dashscope',
      'minimax',
      'sambanova',
      'deepinfra',
      'novita',
      'hyperbolic',
      'nebius',
      'scaleway',
      'github',
      'cloudflare',
      'vercel',
      'requesty',
      'venice',
      'litellm',
      'ollama',
      'lmstudio',
      'llamacpp',
      'vllm',
      'jan',
      'localai',
    ])
      expect(catalogEntry(id), id).toBeDefined();
  });

  it('every entry is well formed: URL, auth, key env vars, links', () => {
    for (const e of PROVIDER_CATALOG) {
      expect(e.baseUrl, e.id).toMatch(e.local ? /^http:\/\/localhost:\d+\// : /^https:\/\//);
      expect(e.name.length, e.id).toBeGreaterThan(1);
      for (const env of e.keyEnvs) expect(env, e.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
      if (e.local) {
        expect(e.auth, e.id).toBe('none');
        expect(e.keyEnvs, e.id).toEqual([]);
      } else {
        expect(e.keyEnvs.length, e.id).toBeGreaterThan(0);
        expect(e.signup, e.id).toMatch(/^https:\/\//);
      }
      if (e.docs) expect(e.docs, e.id).toMatch(/^https:\/\//);
      // Every placeholder has a field, and every field is used.
      expect(templateFields(e.baseUrl).sort(), e.id).toEqual(e.fields.map((f) => f.key).sort());
    }
  });

  it('includes the second-pass hosts, platforms, gateways and local servers', () => {
    for (const id of [
      'ai21',
      'baseten',
      'featherless',
      'chutes',
      'inference-net',
      'friendli',
      'parasail',
      'nscale',
      'crusoe',
      'ionos',
      'upstage',
      'reka',
      'stepfun',
      'stepfun-cn',
      'volcengine',
      'byteplus',
      'qianfan',
      'spark',
      'sensenova',
      'ollama-cloud',
      'snowflake',
      'databricks',
      'helicone',
      'martian',
      'koboldcpp',
      'textgen',
      'llamafile',
      'mlx-lm',
      'aphrodite',
      'sglang',
      'xinference',
      'docker-model-runner',
      'lemonade',
      'gpt4all',
    ])
      expect(catalogEntry(id), id).toBeDefined();
  });

  it('gives every entry a known flavor and keeps local servers keyless and free', () => {
    const flavors = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
    for (const e of PROVIDER_CATALOG) {
      expect(flavors, e.id).toContain(e.flavor);
      if (e.local) expect(e.freeTier, e.id).toBe(true);
      if (e.modelsPath !== null) expect(e.modelsPath, e.id).not.toMatch(/^\//);
    }
  });

  it('fills every templated URL from placeholder values into an https URL', () => {
    for (const e of PROVIDER_CATALOG.filter((x) => x.fields.length > 0)) {
      const values = Object.fromEntries(e.fields.map((f) => [f.key, f.default ?? 'abc-1']));
      const url = new URL(fillBaseUrl(e, values));
      expect(url.protocol, e.id).toBe('https:');
      expect(url.href, e.id).not.toContain('{');
    }
    const dbx = catalogEntry('databricks');
    if (!dbx) throw new Error('no databricks');
    expect(fillBaseUrl(dbx, { workspace: 'dbc-1.cloud.databricks.com' })).toBe(
      'https://dbc-1.cloud.databricks.com/serving-endpoints',
    );
    const dmr = catalogEntry('docker-model-runner');
    if (!dmr) throw new Error('no docker-model-runner');
    expect(modelsUrlFor(dmr, dmr.baseUrl)).toBe('http://localhost:12434/engines/v1/models');
  });

  it('fills templated base URLs and validates the values', () => {
    const azure = catalogEntry('azure');
    if (!azure) throw new Error('no azure');
    expect(fillBaseUrl(azure, { resource: 'my-res' })).toBe(
      'https://my-res.openai.azure.com/openai/v1',
    );
    expect(() => fillBaseUrl(azure, {})).toThrow(/needs resource name/);
    expect(() => fillBaseUrl(azure, { resource: 'evil.com/x?' })).toThrow(/letters, digits/);
    const bedrock = catalogEntry('bedrock');
    if (!bedrock) throw new Error('no bedrock');
    // A field default fills the gap.
    expect(fillBaseUrl(bedrock, {})).toBe('https://bedrock-mantle.us-east-1.api.aws/v1');
    expect(fillBaseUrl(bedrock, { region: 'eu-west-1' })).toContain('eu-west-1');
    const vertex = catalogEntry('vertex');
    if (!vertex) throw new Error('no vertex');
    expect(fillBaseUrl(vertex, { project: 'p1' })).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p1/locations/global/endpoints/openapi',
    );
  });

  it('maps flavors and auth styles onto endpoint config', () => {
    expect(kindForFlavor('openai-chat')).toBe('openai');
    expect(kindForFlavor('openai-responses')).toBe('responses');
    expect(kindForFlavor('anthropic')).toBe('anthropic');
    expect(kindForFlavor('gemini')).toBe('gemini');
    expect(endpointAuth('api-key')).toBe('api-key');
    expect(endpointAuth('none')).toBe('none');
    expect(endpointAuth('bearer')).toBeUndefined();
    const z = catalogEntry('zai');
    if (!z) throw new Error('no zai');
    expect(modelsUrlFor(z, z.baseUrl)).toBe('https://api.z.ai/api/paas/v4/models');
    const pplx = catalogEntry('perplexity');
    if (!pplx) throw new Error('no perplexity');
    expect(modelsUrlFor(pplx, pplx.baseUrl)).toBeUndefined();
  });

  it('every derived template is a valid endpoint config', () => {
    for (const [name, t] of Object.entries(PROVIDER_TEMPLATES)) {
      const parsed = endpointSchema.safeParse({
        kind: t.kind,
        base_url: t.baseUrl,
        ...(t.keyEnv ? { api_key_env: t.keyEnv } : {}),
        ...(t.auth ? { auth: t.auth } : {}),
      });
      expect(parsed.success, name).toBe(true);
    }
    // Templated and built-in entries are not plain templates.
    expect(PROVIDER_TEMPLATES.azure).toBeUndefined();
    expect(PROVIDER_TEMPLATES.anthropic).toBeUndefined();
    expect(PROVIDER_TEMPLATES.nebius?.baseUrl).toBe('https://api.tokenfactory.nebius.com/v1');
  });
});
