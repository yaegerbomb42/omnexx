import { describe, expect, it } from 'vitest';
import {
  acceptanceContractSchema,
  ContractGate,
  type AcceptanceContract,
} from '../../../src/core/contract.js';
import { defineContractTool } from '../../../src/tools/contract.js';
import { strReplaceTool, writeFileTool } from '../../../src/tools/edit.js';
import { PathJail } from '../../../src/security/paths.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Acceptance Contract Gate', () => {
  describe('acceptanceContractSchema', () => {
    it('validates a well-formed 3-part contract', () => {
      const valid: AcceptanceContract = {
        targetFiles: ['src/auth.ts', 'test/auth.test.ts'],
        hypothesis: 'Token expiry calculation off-by-one error causes 401 on valid sessions.',
        verificationCommand: 'npm test -- -t "auth token"',
      };

      const parsed = acceptanceContractSchema.parse(valid);
      expect(parsed.targetFiles).toEqual(['src/auth.ts', 'test/auth.test.ts']);
      expect(parsed.hypothesis).toContain('Token expiry');
      expect(parsed.verificationCommand).toBe('npm test -- -t "auth token"');
    });

    it('rejects contracts with empty targetFiles', () => {
      expect(() =>
        acceptanceContractSchema.parse({
          targetFiles: [],
          hypothesis: 'Refactor without target files',
          verificationCommand: 'npm test',
        }),
      ).toThrow();
    });

    it('rejects contracts with hypothesis under 10 chars', () => {
      expect(() =>
        acceptanceContractSchema.parse({
          targetFiles: ['src/a.ts'],
          hypothesis: 'fix bug',
          verificationCommand: 'npm test',
        }),
      ).toThrow();
    });
  });

  describe('ContractGate enforcement', () => {
    it('allows edits when no contract is active and requireContract is false', () => {
      const gate = new ContractGate('/repo');
      expect(gate.hasContract()).toBe(false);
      expect(gate.contract).toBeNull();

      const result = gate.validateEdit('src/anything.ts', false);
      expect(result.ok).toBe(true);
    });

    it('refuses edits when no contract is active and requireContract is true', () => {
      const gate = new ContractGate('/repo');
      const result = gate.validateEdit('src/anything.ts', true);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Pre-flight acceptance contract required');
    });

    it('locks edits strictly to registered targetFiles', () => {
      const gate = new ContractGate('/repo');
      gate.registerContract({
        targetFiles: ['src/auth/token.ts', 'src/middleware.ts'],
        hypothesis: 'Extract token parsing into separate utility function.',
        verificationCommand: 'npm run test:auth',
      });

      expect(gate.hasContract()).toBe(true);

      // Target files should pass
      expect(gate.validateEdit('src/auth/token.ts').ok).toBe(true);
      expect(gate.validateEdit('./src/auth/token.ts').ok).toBe(true);
      expect(gate.validateEdit('src/middleware.ts').ok).toBe(true);

      // Non-target files must be rejected
      const nonTarget = gate.validateEdit('src/unrelated.ts');
      expect(nonTarget.ok).toBe(false);
      expect(nonTarget.error).toContain('Edit targets "src/unrelated.ts"');
      expect(nonTarget.error).toContain('not listed in the active acceptance contract targetFiles');
    });

    it('resets cleanly when cleared', () => {
      const gate = new ContractGate('/repo');
      gate.registerContract({
        targetFiles: ['src/file.ts'],
        hypothesis: 'A temporary valid hypothesis.',
        verificationCommand: 'npm test',
      });
      expect(gate.hasContract()).toBe(true);

      gate.clearContract();
      expect(gate.hasContract()).toBe(false);
      expect(gate.contract).toBeNull();
      expect(gate.validateEdit('src/other.ts').ok).toBe(true);
    });
  });

  describe('defineContractTool', () => {
    it('registers contract in ToolContext and returns confirmation', async () => {
      const gate = new ContractGate('/repo');
      const ctx = {
        contractGate: gate,
      } as unknown as ToolContext;

      const res = await defineContractTool.run(
        {
          targetFiles: ['src/index.ts', 'src/types.ts'],
          hypothesis: 'Add export for newly implemented acceptance contract models.',
          verificationCommand: 'npm run typecheck',
        },
        ctx,
      );

      expect(res.isError).toBeUndefined();
      expect(res.content).toContain('Pre-flight acceptance contract registered successfully');
      expect(res.content).toContain('src/index.ts, src/types.ts');
      expect(gate.hasContract()).toBe(true);
      expect(gate.contract?.targetFiles).toEqual(['src/index.ts', 'src/types.ts']);
    });
  });

  describe('End-to-End Tool Integration with Edit Tools', () => {
    it('blocks str_replace and write_file when targeting non-contract files', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'omnexx-contract-test-'));
      try {
        const jail = new PathJail(tmp);
        const gate = new ContractGate(tmp);
        gate.registerContract({
          targetFiles: ['allowed.ts'],
          hypothesis: 'Only allowed.ts is permitted to be modified in this task.',
          verificationCommand: 'npm test',
        });

        await writeFile(join(tmp, 'allowed.ts'), 'export const a = 1;\n');
        await writeFile(join(tmp, 'disallowed.ts'), 'export const b = 2;\n');

        const ctx = {
          jail,
          contractGate: gate,
          edited: new Set(),
          reads: new Map(),
        } as unknown as ToolContext;

        // Attempting to modify disallowed.ts with str_replace must fail
        const replaceRes = await strReplaceTool.run(
          {
            path: 'disallowed.ts',
            old_str: 'b = 2;',
            new_str: 'b = 42;',
          },
          ctx,
        );
        expect(replaceRes.isError).toBe(true);
        expect(replaceRes.content).toContain('not listed in the active acceptance contract');

        // Attempting to write disallowed.ts with write_file must fail
        const writeRes = await writeFileTool.run(
          {
            path: 'disallowed.ts',
            content: 'export const b = 99;\n',
          },
          ctx,
        );
        expect(writeRes.isError).toBe(true);
        expect(writeRes.content).toContain('not listed in the active acceptance contract');

        // Modifying allowed.ts with str_replace must succeed
        const allowedReplaceRes = await strReplaceTool.run(
          {
            path: 'allowed.ts',
            old_str: 'a = 1;',
            new_str: 'a = 42;',
          },
          ctx,
        );
        expect(allowedReplaceRes.isError).toBeUndefined();
        expect(allowedReplaceRes.content).toContain('edited allowed.ts');
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
