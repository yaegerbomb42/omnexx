import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackedFiles } from '../../../src/agent/codemap.js';
import { filterChoices, loadModelChoices } from '../../../src/tui/model-picker.js';
import { modelsFetch, testIO } from '../../support/connect.js';
import { tempDir } from '../../support/tmp.js';

describe('/model picker', () => {
  it('lists every configured endpoint model plus the add actions, and filters by words', async () => {
    const io = await testIO(modelsFetch(['kimi-k2.7-code', 'glm-5.3', 'qwen3-coder-plus']));
    await mkdir(io.env.OMNEXX_CONFIG_HOME ?? '', { recursive: true });
    await writeFile(
      join(io.env.OMNEXX_CONFIG_HOME ?? '', 'config.toml'),
      '[providers.endpoints.pool]\nbase_url = "http://127.0.0.1:8000/v1"\nfree = true\n',
    );
    const { items, unreachable } = await loadModelChoices(io);
    expect(unreachable).toEqual([]);
    expect(items.flatMap((i) => (i.kind === 'model' ? [i.ref] : [i.kind]))).toEqual([
      'pool:kimi-k2.7-code',
      'pool:glm-5.3',
      'pool:qwen3-coder-plus',
      'add-key',
      'add-url',
    ]);
    expect(filterChoices(items, 'pool qwen').map((i) => i.kind)).toEqual([
      'model',
      'add-key',
      'add-url',
    ]);
  });
});

describe('chat outside a git repository', () => {
  it('maps files with a bounded walk that skips hidden and dependency folders', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'notes'), { recursive: true });
    await mkdir(join(dir, 'node_modules/x'), { recursive: true });
    await mkdir(join(dir, '.secret'), { recursive: true });
    await writeFile(join(dir, 'notes/a.md'), '# a');
    await writeFile(join(dir, 'node_modules/x/i.js'), '');
    await writeFile(join(dir, '.secret/k'), '');
    expect(await trackedFiles(dir)).toEqual(['notes/a.md']);
  });
});
