import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyVerification,
  factsBlockFor,
  readFacts,
  writeFacts,
  type Verification,
} from '../../../src/core/facts.js';
import { probeRepo } from '../../../src/core/repo-probe.js';
import { tempDir } from '../../support/tmp.js';

const AT = '2026-10-15T09:00:00.000Z';

async function home(): Promise<{ home: string }> {
  return { home: await tempDir('omnexx-probe-home-') };
}

async function write(root: string, name: string, body: string): Promise<void> {
  await writeFile(join(root, name), body);
}

describe('repo probe facts', () => {
  it('records npm test when the script and lockfile exist', async () => {
    const root = await tempDir('omnexx-probe-');
    const paths = await home();
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    await write(root, 'package-lock.json', '{}');

    const block = await factsBlockFor(paths, root, root);
    expect(block).toMatch(/Run tests: `npm test`/);
    const [fact] = await readFacts(paths, root);
    expect(fact).toMatchObject({
      kind: 'test',
      command: 'npm test',
      source: 'probe',
      verified: { exitCode: 0 },
      boundTo: [],
    });
    expect(fact?.probeHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('emits no test fact when package.json has no test script or no package manager', async () => {
    const root = await tempDir('omnexx-probe-');
    const paths = await home();
    await write(root, 'package.json', JSON.stringify({ scripts: { start: 'node index.js' } }));
    await write(root, 'package-lock.json', '{}');
    expect(await factsBlockFor(paths, root, root)).not.toMatch(/Run tests/);
    expect(await readFacts(paths, root)).toEqual([]);

    const guessed = await tempDir('omnexx-probe-');
    await write(guessed, 'package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    expect((await probeRepo(guessed)).facts.map((f) => f.command)).not.toContain('npm test');
  });

  it('keeps the same fact when the inputs do not change', async () => {
    const root = await tempDir('omnexx-probe-');
    const paths = await home();
    await write(
      root,
      'package.json',
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }),
    );
    await write(root, 'package-lock.json', '{}');
    await factsBlockFor(paths, root, root);
    const first = await readFacts(paths, root);
    await factsBlockFor(paths, root, root);
    expect(await readFacts(paths, root)).toEqual(first);
    expect(first.map((f) => f.command)).toEqual(['npm test', 'npm run lint']);
  });

  it('replaces the probe fact when a script body changes', async () => {
    const root = await tempDir('omnexx-probe-');
    const paths = await home();
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    await write(root, 'package-lock.json', '{}');
    await factsBlockFor(paths, root, root);
    const before = (await readFacts(paths, root))[0];

    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest --run' } }));
    await factsBlockFor(paths, root, root);
    const after = (await readFacts(paths, root))[0];
    expect(after?.command).toBe('npm test');
    expect(after?.probeHash).toMatch(/^[a-f0-9]{16}$/);
    expect(after?.probeHash).not.toBe(before?.probeHash);
  });

  it('leaves a remembered fact with a different command in place', async () => {
    const root = await tempDir('omnexx-probe-');
    const paths = await home();
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    await write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const remembered: Verification = {
      kind: 'test',
      statement: 'Use the fast suite: `npm run test:quick`',
      command: 'npm run test:quick',
      source: 'remember',
      exitCode: 0,
      durationMs: 50,
      at: AT,
    };
    await writeFacts(paths, root, applyVerification([], remembered, []));

    await factsBlockFor(paths, root, root);
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest --run' } }));
    await factsBlockFor(paths, root, root);

    const facts = await readFacts(paths, root);
    expect(facts.find((f) => f.source === 'remember')).toMatchObject({
      id: 'F1',
      command: 'npm run test:quick',
      statement: remembered.statement,
    });
    expect(facts.find((f) => f.source === 'probe')).toMatchObject({ command: 'pnpm test' });
  });

  it('reads python, go, rust, and monorepo markers without guessing', async () => {
    const py = await tempDir('omnexx-probe-');
    await write(py, 'pytest.ini', '[pytest]\n');
    await write(py, 'tox.ini', '[tox]\n');
    expect((await probeRepo(py)).facts.map((f) => f.command)).toEqual(['pytest', 'tox']);

    const go = await tempDir('omnexx-probe-');
    await write(go, 'go.mod', 'module example.com/app\n\ngo 1.22\n');
    await write(go, 'go.work', 'go 1.22\n\nuse .\n');
    const goFacts = await probeRepo(go);
    expect(goFacts.facts.map((f) => f.statement)).toEqual([
      'Run tests: `go test ./...`',
      'Monorepo: Go workspace (go.work)',
    ]);

    const rust = await tempDir('omnexx-probe-');
    await write(rust, 'Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\n');
    expect((await probeRepo(rust)).facts.map((f) => f.command)).toEqual([
      'cargo test',
      'cargo build',
    ]);

    const workspace = await tempDir('omnexx-probe-');
    await write(workspace, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    await write(workspace, 'nx.json', '{}\n');
    expect((await probeRepo(workspace)).facts.map((f) => f.statement)).toEqual([
      'Monorepo: pnpm workspaces',
      'Monorepo: nx',
    ]);
  });
});
