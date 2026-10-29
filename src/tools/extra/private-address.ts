import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Hosts that name the cloud metadata service or this machine without being an IP. */
const PRIVATE_NAMES = new Set(['localhost', 'metadata.google.internal', 'metadata']);

const v4 = (ip: string): number[] => ip.split('.').map(Number);

function privateV4(ip: string): boolean {
  const [a = 0, b = 0] = v4(ip);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function privateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (mapped) return privateV4(mapped);
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
}

/** Loopback, private, link-local (cloud metadata), carrier-grade NAT, multicast or unspecified. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind === 6) return privateV6(ip);
  return false;
}

export type Resolve = (host: string) => Promise<readonly string[]>;

const resolveAll: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Why `hostname` must not be fetched, or undefined when every address it resolves to is public.
 * A name that resolves to a private address counts (DNS pointing inward). A name that does not
 * resolve is left to the fetch, which then fails on its own.
 */
export async function privateTarget(
  hostname: string,
  resolve: Resolve = resolveAll,
): Promise<string | undefined> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_NAMES.has(host) || host.endsWith('.localhost'))
    return `${host} is this machine or the cloud metadata service`;
  // Reject alternate (decimal/octet/hex/shorthand) IPv4 spellings that node's isIP does not
  // recognize but an HTTP client may still resolve to a private address.
  if (/^[0-9a-fx.:]+$/i.test(host) && !host.includes(':')) {
    const parts = host.split('.');
    const numericLooking = parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|[0-9]+)$/i.test(p));
    if (numericLooking && parts.length < 5) {
      if (parts.length !== 4 || !isIP(host)) {
        return `${host} is not a safe public hostname`;
      }
    }
  }
  if (isIP(host)) return isPrivateAddress(host) ? `${host} is a private address` : undefined;
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return undefined;
  }
  const inward = addresses.find(isPrivateAddress);
  return inward ? `${host} resolves to the private address ${inward}` : undefined;
}
