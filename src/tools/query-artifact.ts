import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ok, type Tool, type ToolContext, type ToolOutput } from './types.js';

const inputSchema = z.object({
  path: z.string().describe('File path of the artifact to query (relative or absolute).'),
  format: z.enum(['json', 'lines', 'sqlite']).default('json').describe('Format: "json", "lines", or "sqlite".'),
  query: z.string().describe('SQL SELECT query against the artifact table.'),
  limit: z.number().int().min(1).max(500).default(50).describe('Max rows to return.'),
});

type Input = z.infer<typeof inputSchema>;

export const queryArtifactTool: Tool<typeof inputSchema> = {
  name: 'query_artifact',
  description:
    'Query structured logs, JSON dumps, or SQLite tables in-place using SQLite in-memory tables without inflating prompt context.',
  readOnly: true,
  schema: inputSchema,
  async run(input: Input, ctx: ToolContext): Promise<ToolOutput> {
    const root = await realpath(ctx.jail.root).catch(() => ctx.jail.root);
    const resolvedPath = isAbsolute(input.path) ? resolve(input.path) : resolve(ctx.jail.root, input.path);
    const fullPath = await realpath(resolvedPath).catch(() => resolvedPath);
    const sysTmp = await realpath(tmpdir()).catch(() => tmpdir());
    if (!fullPath.startsWith(root) && !fullPath.startsWith(sysTmp) && !fullPath.startsWith('/tmp')) {
      return {
        content: 'Access denied: path must be inside workspace or /tmp',
        isError: true,
      };
    }

    try {
      // Dynamically import node:sqlite at runtime to prevent tsup from rewriting the built-in module specifier
      const { DatabaseSync } = await import('node:sqlite');

      if (input.format === 'sqlite') {
        const db = new DatabaseSync(fullPath, { open: true, readOnly: true });
        try {
          const stmt = db.prepare(input.query);
          const rows = stmt.all();
          const clipped = rows.slice(0, input.limit);
          return ok(
            JSON.stringify(clipped, null, 2) +
              (rows.length > input.limit ? `\n... [${rows.length - input.limit} more rows]` : ''),
          );
        } finally {
          db.close();
        }
      }

      const text = await readFile(fullPath, 'utf8');
      const db = new DatabaseSync(':memory:');

      try {
        if (input.format === 'json') {
          const parsed: unknown = JSON.parse(text);
          const records: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
          db.exec('CREATE TABLE artifact (id INTEGER PRIMARY KEY, data JSON);');
          const insert = db.prepare('INSERT INTO artifact (data) VALUES (?)');
          for (const item of records) {
            insert.run(JSON.stringify(item));
          }
          const stmt = db.prepare(input.query);
          const rows = stmt.all();
          const clipped = rows.slice(0, input.limit);
          return ok(
            JSON.stringify(clipped, null, 2) +
              (rows.length > input.limit ? `\n... [${rows.length - input.limit} more records]` : ''),
          );
        } else {
          const lines = text.split('\n');
          db.exec('CREATE TABLE artifact (line_no INTEGER PRIMARY KEY, text TEXT);');
          const insert = db.prepare('INSERT INTO artifact (line_no, text) VALUES (?, ?)');
          for (let i = 0; i < lines.length; i++) {
            insert.run(i + 1, lines[i] ?? '');
          }
          const stmt = db.prepare(input.query);
          const rows = stmt.all();
          const clipped = rows.slice(0, input.limit);
          return ok(
            JSON.stringify(clipped, null, 2) +
              (rows.length > input.limit ? `\n... [${rows.length - input.limit} more lines]` : ''),
          );
        }
      } finally {
        db.close();
      }
    } catch (err) {
      return {
        content: `Query execution failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
