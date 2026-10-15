import { connect, describeConnect } from '../cli/connect.js';
import type { CliIO } from '../cli/io.js';
import {
  isFlavor,
  needsSetup,
  parseHeaders,
  probeProvider,
  setupProvider,
  type SetupRequest,
} from '../cli/provider-setup.js';
import { PROVIDER_CATALOG } from '../providers/catalog.js';

export const PROVIDER_USAGE = [
  'usage: /provider                      list every provider omnexx knows',
  '       /provider <id> [key] [field=value…]   e.g. /provider azure KEY resource=my-res',
  '       /provider <url> [key] [--header Name:value] [--flavor anthropic]   any endpoint',
  '       /provider test <id|url> [key] [field=value…]   check without saving',
].join('\n');

function catalogList(): string {
  const hosted = PROVIDER_CATALOG.filter((e) => !e.local).map((e) =>
    e.fields.length ? `${e.id} (${e.fields.map((f) => f.key).join(', ')})` : e.id,
  );
  const local = PROVIDER_CATALOG.filter((e) => e.local).map((e) => e.id);
  return [
    `hosted: ${hosted.join(', ')}`,
    `local: ${local.join(', ')}`,
    'or any OpenAI- or Anthropic-compatible URL; the API is detected',
    PROVIDER_USAGE,
  ].join('\n');
}

/** Split `/provider` words into a setup request; throws on a bad flag. */
export function parseProviderArgs(args: readonly string[]): SetupRequest {
  const fields: Record<string, string> = {};
  const headerLines: string[] = [];
  let flavor: SetupRequest['flavor'];
  let target: string | undefined;
  let key: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--header' || a === '-H') headerLines.push(args[++i] ?? '');
    else if (a === '--flavor') {
      const f = args[++i];
      if (!isFlavor(f))
        throw new Error('--flavor: openai-chat, openai-responses, anthropic or gemini');
      flavor = f;
    } else if (target === undefined) target = a;
    else if (/^[a-z_]+=/.test(a)) fields[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
    else key ??= a;
  }
  if (!target) throw new Error(PROVIDER_USAGE);
  const isUrl = /^https?:\/\//i.test(target);
  const headers = headerLines.length ? parseHeaders(headerLines) : undefined;
  return {
    ...(isUrl ? { url: target } : { provider: target }),
    ...(key ? { key } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(headers ? { headers } : {}),
    ...(flavor ? { flavor } : {}),
  };
}

/** `/provider …` in the TUI; returns the text to show. */
export async function runProviderCommand(io: CliIO, args: readonly string[]): Promise<string> {
  if (!args.length) return catalogList();
  if (args[0] === 'test') {
    const r = await probeProvider(io, parseProviderArgs(args.slice(1)));
    const models = r.models.length ? `\nmodels: ${r.models.slice(0, 8).join(', ')}` : '';
    return `${r.ok ? '✓' : '✗'} ${r.detail}${r.ok ? `\nbase URL: ${r.baseUrl}` : ''}${models}`;
  }
  const req = parseProviderArgs(args);
  if (needsSetup(req)) return (await setupProvider(io, req)).message;
  return describeConnect(await connect(io, req.url ?? req.provider ?? '', req.key));
}
