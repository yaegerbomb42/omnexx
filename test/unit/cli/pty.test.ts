import { describe, expect, it } from 'vitest';
import { PtyDaemon, connectPty } from '../../../src/cli/pty.js';

describe('PtyDaemon', () => {
  it('starts daemon on unix domain socket and bridges interactive stream', async () => {
    const daemon = new PtyDaemon({ shell: '/bin/sh' });
    const sockPath = await daemon.start();

    expect(sockPath).toContain('omnexx-pty-');

    const client = await connectPty(sockPath);

    const outputPromise = new Promise<string>((resolve) => {
      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('pty-alive')) {
          resolve(buffer);
        }
      });
    });

    client.write('echo pty-alive\n');
    const out = await outputPromise;
    expect(out).toContain('pty-alive');

    client.end();
    await daemon.stop();
  });
});
