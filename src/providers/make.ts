import type { EndpointConfig } from '../config/schema.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai-compat.js';
import { ResponsesProvider } from './responses.js';
import type { Provider } from './types.js';

const MAKERS: Record<EndpointConfig['kind'], (o: OpenAICompatOptions) => Provider> = {
  openai: (o) => new OpenAICompatProvider(o),
  responses: (o) => new ResponsesProvider(o),
  gemini: (o) => new GeminiProvider(o),
  // Anthropic-compatible gateways: the Messages API at the endpoint's base URL.
  anthropic: (o) =>
    new AnthropicProvider({
      apiKey: o.apiKey ?? '',
      baseURL: o.baseUrl,
      cacheTtl: '5m',
      timeoutMs: o.timeoutMs,
      bearer: o.auth === 'bearer',
      ...(o.headers ? { headers: o.headers } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
    }),
};

/** The client for an endpoint's API kind. */
export function makeEndpointProvider(
  kind: EndpointConfig['kind'],
  opts: OpenAICompatOptions,
): Provider {
  return MAKERS[kind](opts);
}
