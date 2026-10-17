import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProject } from '../../../src/cli/detect.js';
import { parseCargo } from '../../../src/verify/parsers/index.js';
import { narrowCommand, readCrates } from '../../../src/verify/related-tests.js';
import { tempRepo } from '../../support/tmp.js';

const ctx = (exitCode: number) => ({ gate: 'test', exitCode, cwd: '/repo' });

const RED = `   Compiling calc v0.1.0 (/repo/crates/calc)
    Finished test [unoptimized + debuginfo] target(s) in 0.52s
     Running unittests src/lib.rs (target/debug/deps/calc-1a2b)

running 3 tests
test tests::adds ... ok
test tests::divides ... FAILED
test tests::slow ... ignored

failures:

---- tests::divides stdout ----
thread 'tests::divides' panicked at crates/calc/src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 2
 right: 3

failures:
    tests::divides

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/main.rs (target/debug/deps/cli-9f8e)

running 2 tests
test parses ... ok
test prints ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

describe('parseCargo', () => {
  it('sums every test binary and names each failure with its panic', () => {
    const out = parseCargo(RED, ctx(101));
    expect(out.structured).toBe(true);
    expect(out.tests).toEqual({ total: 5, passed: 3, failed: 1, skipped: 1 });
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]?.id).toBe('tests::divides');
    expect(out.failures[0]?.message).toContain('panicked at crates/calc/src/lib.rs:12:9');
    expect(out.failures[0]?.message).toContain('right: 3');
  });

  it('reads a green run as structured with counts', () => {
    const green =
      'running 1 test\ntest a ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    expect(parseCargo(green, ctx(0))).toEqual({
      failures: [],
      tests: { total: 1, passed: 1, failed: 0, skipped: 0 },
      structured: true,
    });
  });

  it('falls back to the exit code for a build that never ran a test', () => {
    const out = parseCargo('error[E0425]: cannot find value `x` in this scope\n', ctx(101));
    expect(out.structured).toBe(false);
    expect(out.failures[0]?.message).toContain('E0425');
  });
});

describe('cargo test narrowing', () => {
  const crates = new Map([
    ['crates/calc/src/lib.rs', 'calc'],
    ['crates/cli/src/main.rs', 'cli'],
    ['crates/calc/Cargo.toml', 'calc'],
  ]);

  it('runs only the changed crates, keeping other options', () => {
    expect(
      narrowCommand(
        'cargo test --release',
        ['crates/cli/src/main.rs', 'crates/calc/src/lib.rs', 'README.md'],
        crates,
      ),
    ).toBe('cargo test -p calc -p cli --release');
  });

  it('runs the full suite when it cannot tell which crates a change affects', () => {
    expect(narrowCommand('cargo test', ['Cargo.toml'], crates)).toBeUndefined();
    expect(narrowCommand('cargo test', ['build.rs'], crates)).toBeUndefined();
    expect(narrowCommand('cargo test', ['crates/calc/src/lib.rs'])).toBeUndefined();
    expect(narrowCommand('cargo test -p calc', ['crates/calc/src/lib.rs'], crates)).toBeUndefined();
    expect(
      narrowCommand('cargo test --workspace', ['crates/calc/src/lib.rs'], crates),
    ).toBeUndefined();
    expect(narrowCommand('cargo test', ['docs/x.md'], crates)).toBeUndefined();
  });

  it('maps files to member packages in a workspace, and to nothing in a single crate', async () => {
    const ws = await tempRepo();
    await writeFile(join(ws, 'Cargo.toml'), '[workspace]\nmembers = ["crates/*"]\n');
    await mkdir(join(ws, 'crates/calc/src/ops'), { recursive: true });
    await writeFile(
      join(ws, 'crates/calc/Cargo.toml'),
      '[package]\nname = "calc"\nversion = "0.1.0"\n\n[dependencies]\nname-like = "1"\n',
    );
    expect(
      await readCrates(ws, ['crates/calc/src/ops/add.rs', 'crates/calc/Cargo.toml', 'README.md']),
    ).toEqual(
      new Map([
        ['crates/calc/src/ops/add.rs', 'calc'],
        ['crates/calc/Cargo.toml', 'calc'],
      ]),
    );

    const single = await tempRepo();
    await writeFile(join(single, 'Cargo.toml'), '[package]\nname = "solo"\n');
    expect(await readCrates(single, ['src/lib.rs'])).toEqual(new Map());
  });

  it('detects a Rust repo with a cargo test gate', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'Cargo.toml'), '[package]\nname = "solo"\n');
    const d = await detectProject(repo);
    expect(d.language).toBe('rust');
    expect(d.gates).toEqual([
      { name: 'test', run: 'cargo test', level: 'ratchet', parser: 'cargo', timeout: '20m' },
    ]);
  });
});
