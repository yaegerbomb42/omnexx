import { describe, expect, it } from 'vitest';
import { isPrivateAddress, privateTarget } from '../../../src/tools/extra/private-address.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:1.1.1.1'])(
    '%s is public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('privateTarget', () => {
  const dns =
    (answers: Record<string, string[]>) =>
    (host: string): Promise<string[]> => {
      const a = answers[host];
      return a ? Promise.resolve(a) : Promise.reject(new Error('ENOTFOUND'));
    };

  it('names metadata hosts, localhost and private IPs, bracketed IPv6 too', async () => {
    const none = dns({});
    expect(await privateTarget('metadata.google.internal', none)).toMatch(/metadata/);
    expect(await privateTarget('app.localhost', none)).toMatch(/this machine/);
    expect(await privateTarget('169.254.169.254', none)).toMatch(/private address/);
    expect(await privateTarget('[::1]', none)).toMatch(/private address/);
  });

  it('refuses a public-looking name whose DNS points inward', async () => {
    const resolve = dns({ 'evil.example': ['93.184.216.34', '10.0.0.5'] });
    expect(await privateTarget('evil.example', resolve)).toBe(
      'evil.example resolves to the private address 10.0.0.5',
    );
  });

  it('allows public names and leaves unresolvable ones to the fetch', async () => {
    const resolve = dns({ 'example.com': ['93.184.216.34'] });
    expect(await privateTarget('example.com', resolve)).toBeUndefined();
    expect(await privateTarget('nope.invalid', resolve)).toBeUndefined();
  });
});
