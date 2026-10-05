import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../../src/cli/io.js';
import { App } from '../../../src/tui/app.js';
import { Session } from '../../../src/tui/session.js';

const io = {
  env: { OMNEXX_HOME: '/nonexistent-omnexx' },
  cwd: '/repo',
  isTTY: false,
} as unknown as CliIO;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('App', () => {
  it('renders the header, why card, input and status bar', () => {
    const s = new Session(io, () => Promise.resolve(0));
    const { lastFrame, unmount } = render(
      <App session={s} version="9.9.9" cwd="/repo" showWhy pollMs={10_000} />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('v9.9.9 · /repo');
    expect(f).toContain('why omnexx over claude code?');
    expect(f).toContain('what should omnexx build?');
    expect(f).toContain('no run attached');
    unmount();
  });

  it('types, suggests slash commands, completes with tab and submits on enter', async () => {
    const calls: string[][] = [];
    const s = new Session(io, (argv) => {
      calls.push([...argv]);
      return Promise.resolve(0);
    });
    const { lastFrame, stdin, unmount } = render(
      <App session={s} version="1" cwd="/r" showWhy={false} pollMs={10_000} />,
    );
    stdin.write('/do');
    await tick();
    expect(lastFrame()).toContain('/doctor');
    stdin.write('\t');
    await tick();
    expect(lastFrame()).toContain('/doctor █');
    stdin.write('--offline');
    await tick();
    stdin.write('\r');
    await tick();
    expect(calls).toEqual([['doctor', '--offline']]);
    stdin.write('/runs\r');
    await tick();
    expect(calls.at(-1)).toEqual(['runs']);
    unmount();
  });
});
