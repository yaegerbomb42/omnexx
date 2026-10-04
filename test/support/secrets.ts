/**
 * Fake secrets built at runtime so no committed file looks like a real token to scanners.
 * Every redaction and leak test greps for these.
 */
export function secretCorpus() {
  const x = (n: number, c = 'x'): string => c.repeat(n);
  return {
    anthropic: 'sk-ant-' + 'api03-' + x(40, 'A') + 'zQ9_',
    openai: 'sk-' + 'proj-' + x(40, 'B'),
    github: 'gh' + 'p_' + x(36, 'C'),
    githubPat: 'github' + '_pat_' + x(22, 'D') + '_' + x(40, 'E'),
    aws: 'AK' + 'IA' + x(16, 'F'),
    slack: 'xo' + 'xb-' + '1234567890-' + x(24, 'g'),
    npm: 'np' + 'm_' + x(36, 'H'),
    jwt: 'ey' + 'J' + x(20, 'i') + '.ey' + 'J' + x(20, 'j') + '.' + x(30, 'k'),
    pem:
      '-----BEGIN ' +
      'RSA PRIVATE KEY-----\n' +
      x(64, 'L') +
      '\n-----END ' +
      'RSA PRIVATE KEY-----',
  } as const;
}

export const secretValues = (): string[] => Object.values(secretCorpus());
