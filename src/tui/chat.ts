import { findProviderKey } from '../auth/keys.js';
import { connect, describeConnect } from '../cli/connect.js';
import type { CliIO } from '../cli/io.js';
import { resolveRunDeps } from '../cli/run-deps.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths } from '../core/paths.js';
import { describeError } from '../errors.js';
import { discoverModels } from '../providers/discovery.js';
import { resolveModelLenient } from '../providers/profiles.js';
import type { ContentBlock, Message, Provider, ToolSpec } from '../providers/types.js';

const SYSTEM = `You are omnexx's setup assistant, talking to the user in their terminal.
Your job: help them connect model providers and custom OpenAI-compatible endpoints.
Use the tools; never invent results. Keys the user pastes reach you as placeholders like
<key-1>: pass the placeholder as the key argument and omnexx swaps in the real key.
Never ask the user to paste a key into anything but this chat. Be brief: plain text, no
markdown headings. When a provider is connected, tell them the model ref to use.`;

const TOOLS: ToolSpec[] = [
  {
    name: 'list_providers',
    description: 'Configured providers, their base URLs and whether a key is set.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'connect_provider',
    description:
      'Add or update a provider. target is a known name (openai, openrouter, groq, deepseek, ' +
      'together, fireworks, mistral, gemini, xai, ollama, lmstudio, vllm, litellm, anthropic) ' +
      'or a base URL of any OpenAI-compatible endpoint. Lists its models to prove it works.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        key: { type: 'string', description: 'API key or a <key-N> placeholder' },
        name: { type: 'string', description: 'name for a URL endpoint (optional)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'list_models',
    description: 'Models a configured provider serves.',
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string' } },
      required: ['provider'],
    },
  },
];

const KEYISH = /\b(sk-ant-|sk-or-|sk-|gsk_|xai-|AIza|fw_)[A-Za-z0-9_\-.]{16,}/g;

/**
 * A direct conversation with one model (`/chat openrouter:some-model`). The model can connect
 * further providers through tools; pasted keys never reach it, only `<key-N>` placeholders.
 */
export class Chat {
  private messages: Message[] = [];
  private keys: string[] = [];

  private constructor(
    private readonly io: CliIO,
    readonly ref: string,
    private readonly provider: Provider,
    private readonly route: string,
    private readonly model: string,
  ) {}

  static async open(io: CliIO, ref: string): Promise<Chat> {
    const { config, deps } = await resolveRunDeps(io, io.cwd, {
      models: { planner: ref, worker: ref, cheap: ref },
    });
    const m = resolveModelLenient(ref, config);
    return new Chat(io, ref, deps.provider, m.provider, m.id);
  }

  /** Replace pasted keys with placeholders; the real values stay here. */
  redact(text: string): string {
    return text.replace(KEYISH, (k) => {
      let i = this.keys.indexOf(k);
      if (i === -1) i = this.keys.push(k) - 1;
      return `<key-${i + 1}>`;
    });
  }

  private unredact(text: string | undefined): string | undefined {
    return text?.replace(/<key-(\d+)>/g, (m, n: string) => this.keys[Number(n) - 1] ?? m);
  }

  /** One user turn: loops through tool calls until the model answers. `say` gets each line. */
  async send(text: string, say: (line: string) => void, maxSteps = 8): Promise<void> {
    this.messages.push({ role: 'user', content: [{ type: 'text', text: this.redact(text) }] });
    for (let step = 0; step < maxSteps; step++) {
      const res = await this.provider.complete({
        model: this.model,
        route: this.route,
        system: [{ text: SYSTEM }],
        tools: TOOLS,
        messages: this.messages,
        maxTokens: 2048,
        messageBreakpoints: [],
      });
      this.messages.push({ role: 'assistant', content: res.content });
      const said = res.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (said) say(said);
      const calls = res.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      if (!calls.length) return;
      const results: ContentBlock[] = [];
      for (const c of calls) {
        say(`· ${c.name}`);
        try {
          results.push({
            type: 'tool_result',
            toolUseId: c.id,
            content: await this.tool(c.name, (c.input ?? {}) as Record<string, unknown>),
          });
        } catch (err) {
          results.push({
            type: 'tool_result',
            toolUseId: c.id,
            content: describeError(err),
            isError: true,
          });
        }
      }
      this.messages.push({ role: 'user', content: results });
    }
    say('(stopped after too many tool calls)');
  }

  private async tool(name: string, input: Record<string, unknown>): Promise<string> {
    const str = (k: string): string | undefined =>
      typeof input[k] === 'string' ? input[k] : undefined;
    switch (name) {
      case 'list_providers': {
        const { config } = await loadConfig({ cwd: this.io.cwd, env: this.io.env });
        const paths = resolvePaths(this.io.env);
        const rows = [
          `anthropic (built-in) key: ${(await findProviderKey(paths, this.io.env, 'anthropic')) ? 'yes' : 'no'}`,
        ];
        for (const [n, ep] of Object.entries(config.providers.endpoints)) {
          const key = await findProviderKey(paths, this.io.env, n, ep.api_key_env);
          rows.push(`${n} ${ep.base_url} key: ${key ? 'yes' : ep.free ? 'not needed' : 'no'}`);
        }
        return rows.join('\n');
      }
      case 'connect_provider': {
        const target = this.unredact(str('target')) ?? '';
        const key = this.unredact(str('key'));
        const nm = str('name');
        // A model that passes the key as the target still works.
        const r = await connect(this.io, target, key, nm ? { name: nm } : {});
        return this.redact(describeConnect(r));
      }
      case 'list_models': {
        const p = str('provider') ?? '';
        const { config } = await loadConfig({ cwd: this.io.cwd, env: this.io.env });
        const ep = config.providers.endpoints[p];
        if (!ep) return `unknown provider "${p}"`;
        const apiKey = (
          await findProviderKey(resolvePaths(this.io.env), this.io.env, p, ep.api_key_env)
        )?.key;
        const models = await discoverModels(
          { baseUrl: ep.base_url, ...(apiKey ? { apiKey } : {}) },
          this.io.fetch ? { fetch: this.io.fetch } : {},
        );
        return models.length ? models.map((m) => m.id).join('\n') : 'no models listed';
      }
      default:
        return `unknown tool ${name}`;
    }
  }
}

/** The model to chat with when `/chat` has no argument: Anthropic if keyed, else any endpoint. */
export async function defaultChatRef(io: CliIO): Promise<string | undefined> {
  const paths = resolvePaths(io.env);
  if (await findProviderKey(paths, io.env, 'anthropic')) return 'anthropic:sonnet';
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  for (const [n, ep] of Object.entries(config.providers.endpoints)) {
    const apiKey = (await findProviderKey(paths, io.env, n, ep.api_key_env))?.key;
    if (!apiKey && !ep.free) continue;
    const models = await discoverModels(
      { baseUrl: ep.base_url, ...(apiKey ? { apiKey } : {}) },
      io.fetch ? { fetch: io.fetch } : {},
    );
    if (models[0]) return `${n}:${models[0].id}`;
  }
  return undefined;
}

/** Whether any provider can be called at all (no network): a key, or a free endpoint. */
export async function hasProvider(io: CliIO): Promise<boolean> {
  const paths = resolvePaths(io.env);
  if (await findProviderKey(paths, io.env, 'anthropic')) return true;
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  for (const [n, ep] of Object.entries(config.providers.endpoints)) {
    if (ep.free || (await findProviderKey(paths, io.env, n, ep.api_key_env))) return true;
  }
  return false;
}
