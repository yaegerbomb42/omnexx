import { isIP } from 'node:net';

/** Loopback, a Tailscale CGNAT address (100.64.0.0/10) or a MagicDNS `*.ts.net` name. */
export function isTrustedJudgeHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.ts.net')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127) return true;
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  }
  return false;
}
