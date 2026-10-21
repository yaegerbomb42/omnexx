import { describe, expect, it } from 'vitest';
import { queryArtifactTool } from '../../../src/tools/query-artifact.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolContext } from '../../support/tool-context.js';

describe('queryArtifactTool', () => {
  it('queries JSON arrays using SQLite json_extract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omnexx-query-'));
    try {
      const data = [
        { id: 1, name: 'alpha', status: 'active' },
        { id: 2, name: 'beta', status: 'pending' },
        { id: 3, name: 'gamma', status: 'active' },
      ];
      const filePath = join(dir, 'test.json');
      await writeFile(filePath, JSON.stringify(data));
      const ctx = await toolContext(dir);

      const res = await queryArtifactTool.run(
        {
          path: filePath,
          format: 'json',
          query: "SELECT json_extract(data, '$.name') as name FROM artifact WHERE json_extract(data, '$.status') = 'active'",
          limit: 10,
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      const output = JSON.parse(res.content) as readonly { readonly name: string }[];
      expect(output).toEqual([{ name: 'alpha' }, { name: 'gamma' }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('queries log lines using SQLite text pattern matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omnexx-query-'));
    try {
      const log = [
        '[INFO] Server started',
        '[ERROR] Connection reset by peer',
        '[INFO] Request received',
        '[ERROR] Timeout waiting for lock',
      ].join('\n');
      const filePath = join(dir, 'server.log');
      await writeFile(filePath, log);
      const ctx = await toolContext(dir);

      const res = await queryArtifactTool.run(
        {
          path: filePath,
          format: 'lines',
          query: "SELECT line_no, text FROM artifact WHERE text LIKE '%[ERROR]%'",
          limit: 10,
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      const output = JSON.parse(res.content) as readonly { readonly line_no: number; readonly text: string }[];
      expect(output).toHaveLength(2);
      expect(output[0]?.line_no).toBe(2);
      expect(output[1]?.line_no).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
