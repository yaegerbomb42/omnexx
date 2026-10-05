import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { runArgs } from '../../../src/security/sandbox-docker.js';

describe('docker sandbox run arguments', () => {
  const spec = {
    name: 'omnexx-r_1',
    worktree: '/w/repo-r_1',
    tmpDir: '/tmp/omnexx-r_1',
    gitDir: '/src/repo/.git',
    docker: defaultConfig({ docker: { network: 'none', cpus: '1.5', memory: '2g' } }).docker,
    uid: 501,
    gid: 20,
  };

  it('mounts only the worktree and scratch dir read-write, .git read-only, and drops privileges', () => {
    const a = runArgs(spec);
    const joined = a.join(' ');
    expect(joined).toContain('-v /w/repo-r_1:/w/repo-r_1:rw');
    expect(joined).toContain('-v /tmp/omnexx-r_1:/tmp/omnexx-r_1:rw');
    expect(joined).toContain('-v /src/repo/.git:/src/repo/.git:ro');
    expect(a.filter((x) => x === '-v')).toHaveLength(3);
    for (const flag of [
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--read-only',
      '--network none',
      '--cpus 1.5',
      '--memory 2g',
      '--pids-limit 1024',
      '--user 501:20',
      '--init',
    ]) {
      expect(joined).toContain(flag);
    }
    expect(a.slice(-3)).toEqual(['node:22-bookworm', 'sleep', 'infinity']);
    expect(joined).not.toMatch(/docker\.sock|--privileged/);
  });

  it('omits the .git mount when there is none', () => {
    expect(runArgs({ ...spec, gitDir: undefined }).filter((x) => x === '-v')).toHaveLength(2);
  });
});
