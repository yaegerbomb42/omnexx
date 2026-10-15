import { UsageError } from '../../errors.js';
import { catalogEntry, PROVIDER_CATALOG } from '../../providers/catalog.js';
import { EXIT } from '../exit-codes.js';
import { println, readLine, type CliIO } from '../io.js';
import { isFlavor, parseHeaders, setupProvider, type SetupRequest } from '../provider-setup.js';

/**
 * `omnexx providers add` for catalog providers whose URL needs values (Azure, Bedrock, Vertex,
 * Cloudflare) and for custom endpoints given only a URL and key: the API flavor is detected by
 * probing. `omnexx providers catalog` lists every provider known by name.
 */

export interface SmartAddOptions {
  baseUrl?: string | undefined;
  key?: string | undefined;
  /** `name=value` pairs for a templated base URL. */
  field?: readonly string[] | undefined;
  /** `Name: value` header lines. */
  header?: readonly string[] | undefined;
  flavor?: string | undefined;
}

/** Whether `providers add` should take the catalog/probe path rather than the classic one. */
export function wantsSmartAdd(name: string, o: SmartAddOptions): boolean {
  const entry = catalogEntry(name);
  const templated = entry !== undefined && entry.fields.length > 0;
  const lists = (o.field?.length ?? 0) + (o.header?.length ?? 0) > 0;
  return templated || lists || o.key !== undefined || o.flavor !== undefined;
}

function parseFields(pairs: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    pairs.map((p) => {
      const cut = p.indexOf('=');
      if (cut < 1) throw new UsageError(`"${p}" is not name=value`, 'e.g. --field resource=my-res');
      return [p.slice(0, cut).trim(), p.slice(cut + 1).trim()];
    }),
  );
}

/** Ask for anything the request still lacks, when a person is at the terminal. */
async function fillInteractively(
  io: CliIO,
  name: string,
  req: SetupRequest,
): Promise<SetupRequest> {
  if (!io.isTTY || process.env.VITEST !== undefined) return req;
  const entry = catalogEntry(name);
  const fields = { ...(req.fields ?? {}) };
  for (const f of entry?.fields ?? []) {
    if (fields[f.key]) continue;
    const answer = await readLine(io, `${f.label}${f.default ? ` [${f.default}]` : ''}: `);
    if (answer?.trim()) fields[f.key] = answer.trim();
  }
  const url =
    req.url ??
    (entry ? undefined : (await readLine(io, 'Base URL (e.g. https://host/v1): '))?.trim());
  const key =
    req.key ??
    (entry?.local ? undefined : (await readLine(io, 'API key (blank for none): '))?.trim());
  return {
    ...req,
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(url ? { url } : {}),
    ...(key ? { key } : {}),
  };
}

export async function providersAddSmart(
  io: CliIO,
  name: string,
  o: SmartAddOptions,
): Promise<number> {
  if (o.flavor !== undefined && !isFlavor(o.flavor))
    throw new UsageError(
      `unknown flavor "${o.flavor}"`,
      'openai-chat, openai-responses, anthropic or gemini',
    );
  const headers = o.header?.length ? parseHeaders(o.header) : undefined;
  const base: SetupRequest = {
    provider: name,
    ...(o.baseUrl ? { url: o.baseUrl } : {}),
    ...(o.key ? { key: o.key } : {}),
    ...(o.field?.length ? { fields: parseFields(o.field) } : {}),
    ...(headers ? { headers } : {}),
    ...(o.flavor ? { flavor: o.flavor } : {}),
  };
  const req = await fillInteractively(io, name, base);
  const r = await setupProvider(io, req);
  println(io.stdout, r.message);
  return r.probe.ok ? EXIT.ok : EXIT.error;
}

/** `omnexx providers catalog`: every provider known by name, with how to set it up. */
export function providersCatalog(io: CliIO): number {
  for (const e of PROVIDER_CATALOG) {
    const needs = e.fields.length
      ? `  --field ${e.fields.map((f) => `${f.key}=…`).join(' --field ')}`
      : '';
    const key = e.local ? 'no key' : (e.keyEnvs[0] ?? 'key');
    const free = e.freeTier && !e.local ? ' free tier' : '';
    println(io.stdout, `${e.id.padEnd(14)} ${e.name} — ${key}${free}${needs}`);
  }
  println(
    io.stdout,
    'anything else: omnexx providers add <name> --base-url <url> --key <key> (flavor auto-detected)',
  );
  return EXIT.ok;
}
