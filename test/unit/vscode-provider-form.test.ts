import { beforeEach, describe, expect, it } from 'vitest';
import { modelDetailTags } from '../../vscode/src/webview/badge.js';
import * as form from '../../vscode/src/webview/providerForm.js';

const azure: form.FormProvider = {
  name: 'azure',
  label: 'Azure OpenAI',
  baseUrl: 'https://{resource}.openai.azure.com/openai/v1',
  local: false,
  fields: [{ key: 'resource', label: 'Resource name', placeholder: 'my-resource' }],
  note: 'model names are your deployment names',
};

describe('settings: provider form extras', () => {
  beforeEach(() => {
    form.reset();
  });

  it('renders the fields a templated provider needs, with its note', () => {
    const html = form.extrasHtml(azure, false);
    expect(html).toContain('data-extra="f-resource"');
    expect(html).toContain('deployment names');
    expect(html).not.toContain('add-x-flavor');
  });

  it('asks for a missing field, then reads typed values', () => {
    expect(form.readExtras(azure, false)).toBe('Enter the resource name first');
    form.remember({ dataset: { extra: 'f-resource' }, value: 'my-res' });
    expect(form.readExtras(azure, false)).toEqual({ fields: { resource: 'my-res' } });
  });

  it('reads a custom endpoint flavor and headers, refusing a malformed header', () => {
    expect(form.extrasHtml(undefined, true)).toContain('Detect automatically');
    form.remember({ dataset: { extra: 'flavor' }, value: 'anthropic' });
    form.remember({ dataset: { extra: 'headers' }, value: 'X-Org: team\n\n' });
    expect(form.readExtras(undefined, true)).toEqual({
      flavor: 'anthropic',
      headers: { 'X-Org': 'team' },
    });
    form.remember({ dataset: { extra: 'headers' }, value: 'oops' });
    expect(form.readExtras(undefined, true)).toMatch(/not a header/);
  });

  it('shows a running test, then its result, escaping server text', () => {
    expect(form.probeFailed('x')).toBeUndefined();
    expect(form.startProbe()).toContain('testing');
    const html = form.onProbe({
      ok: false,
      detail: '401: key <rejected>',
      baseUrl: '',
      models: [],
    });
    expect(html).toContain('✗ 401: key &lt;rejected&gt;');
    form.startProbe();
    expect(form.probeFailed('bad URL')).toContain('bad URL');
    expect(
      form.onProbe({ ok: true, detail: '2 models', baseUrl: 'https://h/v1', models: ['a', 'b'] }),
    ).toContain('a, b');
  });
});

describe('model picker: model detail tags', () => {
  it('reads a free tag and a parameter size from the model id', () => {
    expect(modelDetailTags('llama-3.3-70b:free')).toEqual(['free', '70b']);
    expect(modelDetailTags('qwen2.5-coder-32b-instruct')).toEqual(['32b']);
    expect(modelDetailTags('gpt-4o')).toEqual([]);
  });

  it('recognizes a bare free tag and mixed-case or mixed-expert sizes', () => {
    expect(modelDetailTags('free')).toEqual(['free']);
    expect(modelDetailTags('mixtral-8x7b-free')).toEqual(['free', '8x7b']);
    expect(modelDetailTags('Gemma-2-27B')).toEqual(['27b']);
  });
});
