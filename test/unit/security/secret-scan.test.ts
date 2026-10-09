import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scanPatchForSecrets,
  scanTextForSecrets,
  shannonEntropy,
} from '../../../src/security/secret-scan.js';

describe('secret-scan: entropy and regex', () => {
  it('shannonEntropy calculates correct entropy', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBe(1);
    // Random alphanumeric strings should have high entropy >= 4.0
    expect(shannonEntropy('g9Z1w4K8pL0mN2qR5vT7xY3bC6dF8hJ1')).toBeGreaterThan(4.2);
  });

  it('detects 20 seeded secrets across multiple categories', () => {
    const x = (n: number, c = 'x'): string => c.repeat(n);
    const seeded = [
      // 1. Anthropic
      'sk-ant-' + 'api03-' + x(40, 'a') + '_-',
      // 2. OpenAI project
      'sk-' + 'proj-' + x(40, 'b'),
      // 3. OpenAI svcacct
      'sk-' + 'svcacct-' + x(40, 'c'),
      // 4. GitHub personal access token
      'gh' + 'p_' + x(36, 'd'),
      // 5. GitHub oauth token
      'gh' + 'o_' + x(36, 'e'),
      // 6. GitHub user token
      'gh' + 'u_' + x(36, 'f'),
      // 7. GitHub fine-grained token
      'github' + '_pat_' + x(22, 'g') + '_' + x(40, 'h'),
      // 8. AWS AKIA
      'AK' + 'IA' + x(16, 'J'),
      // 9. AWS ASIA
      'AS' + 'IA' + x(16, 'K'),
      // 10. Slack user token
      'xo' + 'xp-' + '1234567890-' + x(24, 'l'),
      // 11. Slack bot token
      'xo' + 'xb-' + '1234567890-' + x(24, 'm'),
      // 12. NPM token
      'np' + 'm_' + x(36, 'n'),
      // 13. JWT token
      'ey' + 'J' + x(20, 'o') + '.ey' + 'J' + x(20, 'p') + '.' + x(30, 'q'),
      // 14. GitLab personal token
      'gl' + 'pat-' + x(20, 'r'),
      // 15. Google AI / API Key
      'AI' + 'za' + x(35, 's'),
      // 16. Stripe live secret key
      'sk_' + 'live_' + x(24, 't'),
      // 17. HuggingFace token
      'hf' + '_' + x(34, 'u'),
      // 18. Private Key PEM
      '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + x(64, 'v') + '\n-----END RSA PRIVATE KEY-----',
      // 19. High-entropy random hex/alphanumeric secret (e.g. database password or secret)
      'Xj9#kL2!pQ8$vR5*mN3@zW7+yB1%tF6^',
      // 20. Generic high-entropy base64 key
      'dGVzdC1zZWNyZXQta2V5LXZhbHVlLWZvci1lbnRyb3B5LWNoZWNrLTEyMzQ1Njc4OTA=',
    ];

    expect(seeded.length).toBe(20);

    let detectedCount = 0;
    for (const secret of seeded) {
      const patch = `--- a/config.ts\n+++ b/config.ts\n@@ -1,1 +1,2 @@\n+const token = "${secret}";\n`;
      const res = scanPatchForSecrets(patch);
      if (!res.clean) {
        detectedCount++;
      }
    }

    expect(detectedCount).toBe(20);
  });

  it('respects allowlist glob patterns', () => {
    const patch =
      `--- a/test/fixtures/token.txt\n+++ b/test/fixtures/token.txt\n@@ -1,1 +1,2 @@\n+` +
      'sk-ant-' +
      `api03-abcdefghijklmnopqrstuvwxyz0123456789_-\n`;
    const resBlocked = scanPatchForSecrets(patch, { allowlist: [] });
    expect(resBlocked.clean).toBe(false);

    const resAllowed = scanPatchForSecrets(patch, {
      allowlist: ['test/fixtures/**', '*.txt'],
    });
    expect(resAllowed.clean).toBe(true);
    expect(resAllowed.findings).toHaveLength(0);
  });

  it('scanTextForSecrets finds secrets in raw file content', () => {
    const content = `// credentials\nexport const KEY = "` + 'AK' + 'IA1234567890ABCDEF";\n';
    const res = scanTextForSecrets('src/auth.ts', content);
    expect(res.clean).toBe(false);
    expect(res.findings[0]?.reason).toContain('AWS Access Key ID');
  });

  it('has ZERO false positives across all src/ files of omnexx repo', async () => {
    const repoRoot = process.cwd();
    async function getFiles(dir: string): Promise<string[]> {
      const dirents = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const d of dirents) {
        const full = join(dir, d.name);
        if (d.isDirectory()) {
          files.push(...(await getFiles(full)));
        } else if (d.name.endsWith('.ts') || d.name.endsWith('.js') || d.name.endsWith('.json')) {
          files.push(full);
        }
      }
      return files;
    }

    const srcFiles = await getFiles(join(repoRoot, 'src'));
    expect(srcFiles.length).toBeGreaterThan(30);

    const falsePositives: { file: string; finding: unknown }[] = [];
    for (const file of srcFiles) {
      const relPath = file.replace(repoRoot + '/', '');
      const content = await readFile(file, 'utf8');
      const res = scanTextForSecrets(relPath, content);
      if (!res.clean) {
        for (const finding of res.findings) {
          falsePositives.push({ file: relPath, finding });
        }
      }
    }

    expect(falsePositives).toEqual([]);
  });
});
