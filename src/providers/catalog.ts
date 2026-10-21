/**
 * Every model provider omnexx knows by name, as data (checked 2026-10 against each provider's
 * docs). The CLI (`omnexx providers`, `/connect`, `/provider`), the TUI and the VS Code settings
 * gallery all read this one list. Anything not listed still works through the custom flow: a base
 * URL and a key, with the API flavor detected by probing (src/providers/probe.ts).
 */

import {
  AZURE_RESOURCE,
  type ApiFlavor,
  type AuthStyle,
  type CatalogEntry,
  hosted,
  local,
  REGION,
} from './catalog-types.js';
import { MORE_HOSTED, MORE_LOCAL } from './catalog-more.js';

export type { ApiFlavor, AuthStyle, CatalogEntry, CatalogField } from './catalog-types.js';

export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  hosted(
    'anthropic',
    'Anthropic (Claude)',
    'https://api.anthropic.com',
    'ANTHROPIC_API_KEY',
    'https://console.anthropic.com/settings/keys',
    { keyPrefix: 'sk-ant-', flavor: 'anthropic', auth: 'x-api-key', modelsPath: 'v1/models' },
  ),
  hosted(
    'openai',
    'OpenAI',
    'https://api.openai.com/v1',
    'OPENAI_API_KEY',
    'https://platform.openai.com/api-keys',
    { keyPrefix: 'sk-' },
  ),
  hosted(
    'gemini',
    'Google Gemini',
    'https://generativelanguage.googleapis.com',
    'GEMINI_API_KEY',
    'https://aistudio.google.com/apikey',
    {
      keyPrefix: 'AIza',
      flavor: 'gemini',
      auth: 'x-goog-api-key',
      keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      modelsPath: 'v1beta/models',
      freeTier: true,
    },
  ),
  hosted('xai', 'xAI (Grok)', 'https://api.x.ai/v1', 'XAI_API_KEY', 'https://console.x.ai', {
    keyPrefix: 'xai-',
  }),
  hosted(
    'mistral',
    'Mistral',
    'https://api.mistral.ai/v1',
    'MISTRAL_API_KEY',
    'https://console.mistral.ai/api-keys',
    { freeTier: true },
  ),
  hosted(
    'deepseek',
    'DeepSeek',
    'https://api.deepseek.com/v1',
    'DEEPSEEK_API_KEY',
    'https://platform.deepseek.com/api_keys',
  ),
  hosted(
    'groq',
    'Groq',
    'https://api.groq.com/openai/v1',
    'GROQ_API_KEY',
    'https://console.groq.com/keys',
    { keyPrefix: 'gsk_', freeTier: true },
  ),
  hosted(
    'cerebras',
    'Cerebras',
    'https://api.cerebras.ai/v1',
    'CEREBRAS_API_KEY',
    'https://cloud.cerebras.ai',
    { keyPrefix: 'csk-', freeTier: true },
  ),
  hosted(
    'inception',
    'Inception Labs (Mercury-3)',
    'https://api.inceptionlabs.ai/v1',
    'INCEPTION_API_KEY',
    'https://inceptionlabs.ai',
    {
      keyPrefix: 'sk_',
      freeTier: true,
      note: 'Fast diffusion-based reasoning models with 100M free tokens.',
      docs: 'https://docs.inceptionlabs.ai',
    },
  ),
  hosted(
    'openrouter',
    'OpenRouter (hundreds of models)',
    'https://openrouter.ai/api/v1',
    'OPENROUTER_API_KEY',
    'https://openrouter.ai/keys',
    {
      keyPrefix: 'sk-or-',
      freeTier: true,
      note: 'Access hundreds of models with free options (ending in :free).',
    },
  ),
  hosted(
    'together',
    'Together AI',
    'https://api.together.xyz/v1',
    'TOGETHER_API_KEY',
    'https://api.together.ai/settings/api-keys',
  ),
  hosted(
    'fireworks',
    'Fireworks',
    'https://api.fireworks.ai/inference/v1',
    'FIREWORKS_API_KEY',
    'https://fireworks.ai/account/api-keys',
    { keyPrefix: 'fw_' },
  ),
  hosted(
    'nvidia',
    'NVIDIA NIM',
    'https://integrate.api.nvidia.com/v1',
    'NVIDIA_API_KEY',
    'https://build.nvidia.com',
    { keyPrefix: 'nvapi-', freeTier: true },
  ),
  hosted(
    'moonshot',
    'Moonshot (Kimi)',
    'https://api.moonshot.ai/v1',
    'MOONSHOT_API_KEY',
    'https://platform.moonshot.ai/console/api-keys',
  ),
  hosted(
    'zai',
    'Z.ai (GLM)',
    'https://api.z.ai/api/paas/v4',
    'ZAI_API_KEY',
    'https://z.ai/manage-apikey/apikey-list',
  ),
  hosted(
    'zhipu',
    'Zhipu BigModel (GLM, China)',
    'https://open.bigmodel.cn/api/paas/v4',
    'ZHIPUAI_API_KEY',
    'https://open.bigmodel.cn/usercenter/apikeys',
  ),
  hosted(
    'dashscope',
    'Alibaba Cloud (Qwen)',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'DASHSCOPE_API_KEY',
    'https://modelstudio.console.alibabacloud.com',
  ),
  hosted(
    'minimax',
    'MiniMax',
    'https://api.minimax.io/v1',
    'MINIMAX_API_KEY',
    'https://platform.minimax.io/user-center/basic-information/interface-key',
  ),
  hosted(
    'siliconflow',
    'SiliconFlow',
    'https://api.siliconflow.com/v1',
    'SILICONFLOW_API_KEY',
    'https://cloud.siliconflow.com/account/ak',
  ),
  hosted(
    'deepinfra',
    'DeepInfra',
    'https://api.deepinfra.com/v1/openai',
    'DEEPINFRA_API_KEY',
    'https://deepinfra.com/dash/api_keys',
  ),
  hosted(
    'huggingface',
    'Hugging Face Inference',
    'https://router.huggingface.co/v1',
    'HF_TOKEN',
    'https://huggingface.co/settings/tokens',
    { keyPrefix: 'hf_', freeTier: true },
  ),
  hosted(
    'perplexity',
    'Perplexity',
    'https://api.perplexity.ai',
    'PERPLEXITY_API_KEY',
    'https://www.perplexity.ai/settings/api',
    { keyPrefix: 'pplx-', modelsPath: null },
  ),
  hosted(
    'cohere',
    'Cohere',
    'https://api.cohere.ai/compatibility/v1',
    'COHERE_API_KEY',
    'https://dashboard.cohere.com/api-keys',
    { keyEnvs: ['COHERE_API_KEY', 'CO_API_KEY'], freeTier: true },
  ),
  hosted(
    'vercel',
    'Vercel AI Gateway',
    'https://ai-gateway.vercel.sh/v1',
    'AI_GATEWAY_API_KEY',
    'https://vercel.com/ai-gateway',
  ),
  hosted(
    'github',
    'GitHub Models',
    'https://models.github.ai/inference',
    'GITHUB_TOKEN',
    'https://github.com/settings/tokens',
    { freeTier: true, modelsPath: null, note: 'a token with the models:read permission' },
  ),
  hosted(
    'novita',
    'Novita AI',
    'https://api.novita.ai/v3/openai',
    'NOVITA_API_KEY',
    'https://novita.ai/settings/key-management',
  ),
  hosted(
    'hyperbolic',
    'Hyperbolic',
    'https://api.hyperbolic.xyz/v1',
    'HYPERBOLIC_API_KEY',
    'https://app.hyperbolic.xyz/settings',
  ),
  hosted(
    'sambanova',
    'SambaNova',
    'https://api.sambanova.ai/v1',
    'SAMBANOVA_API_KEY',
    'https://cloud.sambanova.ai/apis',
    { freeTier: true },
  ),
  hosted(
    'nebius',
    'Nebius Token Factory',
    'https://api.tokenfactory.nebius.com/v1',
    'NEBIUS_API_KEY',
    'https://tokenfactory.nebius.com',
  ),
  hosted(
    'scaleway',
    'Scaleway Generative APIs',
    'https://api.scaleway.ai/v1',
    'SCW_SECRET_KEY',
    'https://console.scaleway.com/iam/api-keys',
  ),
  hosted(
    'requesty',
    'Requesty',
    'https://router.requesty.ai/v1',
    'REQUESTY_API_KEY',
    'https://app.requesty.ai/api-keys',
  ),
  hosted(
    'venice',
    'Venice',
    'https://api.venice.ai/api/v1',
    'VENICE_API_KEY',
    'https://venice.ai/settings/api',
  ),
  hosted(
    'azure',
    'Azure OpenAI',
    'https://{resource}.openai.azure.com/openai/v1',
    'AZURE_OPENAI_API_KEY',
    'https://portal.azure.com',
    {
      auth: 'api-key',
      fields: [AZURE_RESOURCE],
      note: 'model names are your deployment names',
      docs: 'https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle',
    },
  ),
  hosted(
    'azure-foundry',
    'Azure AI Foundry (DeepSeek, Grok, Llama, …)',
    'https://{resource}.services.ai.azure.com/openai/v1',
    'AZURE_INFERENCE_CREDENTIAL',
    'https://ai.azure.com',
    {
      auth: 'api-key',
      fields: [AZURE_RESOURCE],
      note: 'model names are your deployment names',
      docs: 'https://learn.microsoft.com/azure/ai-foundry/foundry-models/how-to/use-chat-completions',
    },
  ),
  hosted(
    'bedrock',
    'Amazon Bedrock',
    'https://bedrock-mantle.{region}.api.aws/v1',
    'AWS_BEARER_TOKEN_BEDROCK',
    'https://console.aws.amazon.com/bedrock/home#/api-keys',
    {
      fields: [REGION('us-east-1')],
      note: 'uses a Bedrock API key (bearer); SigV4 signing is not supported',
      docs: 'https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html',
    },
  ),
  hosted(
    'vertex',
    'Google Vertex AI',
    'https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi',
    'VERTEX_ACCESS_TOKEN',
    'https://console.cloud.google.com/vertex-ai',
    {
      fields: [
        { key: 'project', label: 'Project ID', placeholder: 'my-gcp-project' },
        { key: 'location', label: 'Location', placeholder: 'global', default: 'global' },
      ],
      modelsPath: null,
      note: 'the key is an access token from `gcloud auth print-access-token` (expires hourly)',
      docs: 'https://cloud.google.com/vertex-ai/generative-ai/docs/start/openai',
    },
  ),
  hosted(
    'cloudflare',
    'Cloudflare Workers AI',
    'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
    'CLOUDFLARE_API_TOKEN',
    'https://dash.cloudflare.com/profile/api-tokens',
    {
      fields: [{ key: 'account', label: 'Account ID', placeholder: '0123abcd…' }],
      freeTier: true,
      modelsPath: null,
    },
  ),
  ...MORE_HOSTED,
  local('ollama', 'Ollama', 'http://localhost:11434/v1', 'https://ollama.com/download'),
  local('lmstudio', 'LM Studio', 'http://localhost:1234/v1', 'https://lmstudio.ai'),
  local('vllm', 'vLLM', 'http://localhost:8000/v1', 'https://docs.vllm.ai'),
  local(
    'llamacpp',
    'llama.cpp server',
    'http://localhost:8080/v1',
    'https://github.com/ggml-org/llama.cpp',
  ),
  local('litellm', 'LiteLLM proxy', 'http://localhost:4000/v1', 'https://docs.litellm.ai'),
  local('jan', 'Jan', 'http://localhost:1337/v1', 'https://jan.ai'),
  local('localai', 'LocalAI', 'http://localhost:8080/v1', 'https://localai.io'),
  ...MORE_LOCAL,
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  const lower = id.toLowerCase();
  return PROVIDER_CATALOG.find((e) => e.id === lower);
}

/** The `{field}` names a base URL template still needs. */
export function templateFields(baseUrl: string): string[] {
  return [...baseUrl.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] ?? '');
}

/** Characters allowed in a templated URL value: host labels, project ids, regions. */
const FIELD_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Fill a base URL template from the form's values (field defaults fill gaps). Throws naming the
 * field when one is missing or holds anything but letters, digits, `.`, `_` and `-`.
 */
export function fillBaseUrl(
  entry: CatalogEntry,
  values: Record<string, string | undefined>,
): string {
  return entry.baseUrl.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    const field = entry.fields.find((f) => f.key === key);
    const value = (values[key] ?? '').trim() || field?.default;
    const label = field?.label ?? key;
    if (!value) throw new Error(`${entry.name} needs ${label.toLowerCase()}`);
    if (!FIELD_VALUE.test(value))
      throw new Error(`${label} "${value}" can only hold letters, digits, ., _ and -`);
    return value;
  });
}

/** The model-list URL for a base URL, or undefined when the provider has none. */
export function modelsUrlFor(entry: CatalogEntry, baseUrl: string): string | undefined {
  if (entry.modelsPath === null) return undefined;
  return `${baseUrl.replace(/\/+$/, '')}/${entry.modelsPath}`;
}

/** The endpoint `kind` in config for a flavor. */
export function kindForFlavor(flavor: ApiFlavor): 'openai' | 'responses' | 'gemini' | 'anthropic' {
  if (flavor === 'openai-chat') return 'openai';
  if (flavor === 'openai-responses') return 'responses';
  return flavor;
}

/** The endpoint config `auth` value for a catalog auth style; undefined is the default (bearer). */
export function endpointAuth(auth: AuthStyle): 'api-key' | 'none' | undefined {
  return auth === 'api-key' || auth === 'none' ? auth : undefined;
}
