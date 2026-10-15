import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FactRecorder } from '../../../src/core/fact-recorder.js';
import {
  applyVerification,
  bindingHashes,
  classifyCommand,
  FACTS_BLOCK_MAX_TOKENS,
  factsBlockFor,
  readFacts,
  renderFactsBlock,
  withStaleness,
  type Fact,
  type Verification,
} from '../../../src/core/facts.js';
import type { ExecResult } from '../../../src/core/exec.js';
import { estimateTokens } from '../../../src/core/tokens.js';
import { tempDir } from '../../support/tmp.js';

const AT = '2026-10-15T09:00:00.000Z';
const passed = (durationMs = 1200): ExecResult => ({
  exitCode: 0,
  timedOut: false,
  aborted: false,
  output: 'ok',
  durationMs,
});
const failed: ExecResult = { ...passed(), exitCode: 1 };

async function setup(): Promise<{ root: string; paths: { home: string } }> {
  const root = await tempDir('omnexx-facts-repo-');
  await writeFile(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}');
  return { root, paths: { home: await tempDir('omnexx-facts-home-') } };
}

function recorder(root: string, paths: { home: string }, gates: string[] = []): FactRecorder {
  return new FactRecorder({
    paths,
    repoRoot: root,
    workdir: root,
    gateCommands: gates,
    now: () => Date.parse(AT),
  });
}

describe('classifyCommand', () => {
  it('classifies build, test, lint, typecheck and install commands', () => {
    expect(classifyCommand('npm test')).toBe('test');
    expect(classifyCommand('cd web && npm run test:quick')).toBe('test');
    expect(classifyCommand('CI=1 pytest -q')).toBe('test');
    expect(classifyCommand('npm run lint')).toBe('lint');
    expect(classifyCommand('npx tsc --noEmit')).toBe('typecheck');
    expect(classifyCommand('cargo build --release')).toBe('build');
    expect(classifyCommand('npm ci')).toBe('env');
  });

  it('ignores commands that only mention a test', () => {
    expect(classifyCommand('git commit -m "add tests"')).toBeUndefined();
    expect(classifyCommand('cat test/a.ts')).toBeUndefined();
    expect(classifyCommand('ls')).toBeUndefined();
    expect(classifyCommand(`npm test ${'x'.repeat(300)}`)).toBeUndefined();
  });
});

describe('recording facts', () => {
  it('records a passing gate as a gate fact bound to package.json', async () => {
    const { root, paths } = await setup();
    const r = recorder(root, paths, ['npm test']);
    const exec = r.wrap(() => Promise.resolve(passed(4200)));

    await exec('npm test', { cwd: root, env: {}, timeoutMs: 1000 });
    await r.flush();

    const [fact] = await readFacts(paths, root);
    expect(fact).toMatchObject({
      id: 'F1',
      kind: 'test',
      command: 'npm test',
      source: 'gate',
      verified: { exitCode: 0, at: AT, durationMs: 4200 },
    });
    expect(fact?.boundTo.map((b) => b.path)).toEqual(['package.json']);
  });

  it('records an agent command that passed, skips unclassified and failing new ones', async () => {
    const { root, paths } = await setup();
    const r = recorder(root, paths);
    r.observe('npm run lint', passed());
    r.observe('ls -la', passed());
    r.observe('npm run build', failed);
    await r.flush();

    const facts = await readFacts(paths, root);
    expect(facts.map((f) => [f.kind, f.command, f.source])).toEqual([
      ['lint', 'npm run lint', 'command'],
    ]);
  });

  it('re-running a command updates its fact instead of adding another', async () => {
    const { root, paths } = await setup();
    const r = recorder(root, paths);
    r.observe('npm test', passed(1000));
    r.observe('npm test', passed(2000));
    await r.flush();
    const facts = await readFacts(paths, root);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.verified.durationMs).toBe(2000);
  });

  it('a later failure of a known command marks it stale', async () => {
    const { root, paths } = await setup();
    const r = recorder(root, paths);
    r.observe('npm test', passed());
    r.observe('npm test', { ...failed, timedOut: true });
    await r.flush();
    expect((await readFacts(paths, root))[0]?.stale).toBe(true);
  });

  it('promotes a remembered lesson whose command passed this session', async () => {
    const { root, paths } = await setup();
    const r = recorder(root, paths);
    r.observe('docker compose up -d db', passed());
    r.promoteNotes([
      { id: 'N1', type: 'env', text: 'Start the db first: `docker compose up -d db`', date: '' },
      { id: 'N2', type: 'env', text: 'Needs `make seed` (never ran)', date: '' },
      { id: 'N3', type: 'flaky', text: '`docker compose up -d db` is flaky', date: '' },
    ]);
    await r.flush();
    const facts = await readFacts(paths, root);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: 'env',
      source: 'remember',
      statement: 'Start the db first: `docker compose up -d db`',
    });
  });

  it('reports a write failure instead of throwing', async () => {
    const { root } = await setup();
    const blocker = join(root, 'package.json');
    const errors: string[] = [];
    const r = new FactRecorder({
      paths: { home: blocker },
      repoRoot: root,
      workdir: root,
      now: () => 0,
      onError: (e) => errors.push(e.message),
    });
    r.observe('npm test', passed());
    await r.flush();
    expect(errors).toHaveLength(1);
  });
});

describe('invalidation', () => {
  it('a fact goes stale when a bound file changes, and a rerun verifies it again', async () => {
    const { root, paths } = await setup();
    const r = recorder(root, paths);
    r.observe('npm test', passed());
    await r.flush();
    expect((await withStaleness(await readFacts(paths, root), root))[0]?.stale).toBe(false);

    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"jest"}}');
    const stale = await withStaleness(await readFacts(paths, root), root);
    expect(stale[0]?.stale).toBe(true);
    expect(await factsBlockFor(paths, root, root)).toMatch(/unverified/);

    r.observe('npm test', passed());
    await r.flush();
    expect((await withStaleness(await readFacts(paths, root), root))[0]?.stale).toBe(false);
  });

  it('a removed bound file also makes it stale', async () => {
    const { root } = await setup();
    const boundTo = await bindingHashes(root);
    const fact = applyVerification([], verification('npm test'), boundTo)[0] as Fact;
    const other = await tempDir();
    expect((await withStaleness([fact], other))[0]?.stale).toBe(true);
  });
});

function verification(command: string, at = AT): Verification {
  return {
    kind: classifyCommand(command) ?? 'run',
    statement: `runs \`${command}\``,
    command,
    source: 'command',
    exitCode: 0,
    durationMs: 1000,
    at,
  };
}

describe('the facts block', () => {
  it('stays under the token cap and puts gates and verified facts first', () => {
    let facts: Fact[] = [];
    for (let i = 0; i < 30; i++)
      facts = applyVerification(facts, verification(`npm run test:part${i}`), []);
    facts = applyVerification(facts, { ...verification('npm run build'), source: 'gate' }, []);
    const block = renderFactsBlock(facts);
    expect(estimateTokens(block)).toBeLessThanOrEqual(FACTS_BLOCK_MAX_TOKENS);
    expect(block.split('\n')[1]).toContain('npm run build');
  });

  it('leaves out facts that are already lessons, and is empty with no facts', () => {
    const facts = applyVerification([], verification('npm test'), []);
    expect(renderFactsBlock(facts, ['Runs `npm test`'])).toBe('');
    expect(renderFactsBlock([])).toBe('');
  });

  it('reads no facts from a corrupt file', async () => {
    const { root, paths } = await setup();
    const r = recorder(root, paths);
    r.observe('npm test', passed());
    await r.flush();
    const { factsFile } = await import('../../../src/core/facts.js');
    await writeFile(await factsFile(paths, root), '{nope');
    expect(await readFacts(paths, root)).toEqual([]);
  });
});
