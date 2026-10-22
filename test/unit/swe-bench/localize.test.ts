import { describe, expect, it } from 'vitest';
import {
  parseStackTraces,
  extractKeyTerms,
  localizeToFiles,
  renderLocalization,
} from '../../../src/swe-bench/localize.js';
import type { Codemap } from '../../../src/agent/codemap.js';

describe('localize', () => {
  describe('parseStackTraces', () => {
    it('parses Python stack traces', () => {
      const issue = `
Traceback (most recent call last):
  File "src/auth/login.py", line 42, in authenticate
    validate_token(token)
  File "src/auth/token.py", line 15, in validate_token
    raise InvalidTokenError()
InvalidTokenError: Token expired
`;
      const files = parseStackTraces(issue);
      expect(files).toContain('src/auth/login.py');
      expect(files).toContain('src/auth/token.py');
    });

    it('parses JavaScript/TypeScript stack traces', () => {
      const issue = `
Error: Authentication failed
    at AuthService.login (src/services/auth.ts:42:15)
    at UserController.handleLogin (src/controllers/user.ts:28:10)
    at Router.dispatch (node_modules/router/index.js:120:5)
`;
      const files = parseStackTraces(issue);
      expect(files).toContain('src/services/auth.ts');
      expect(files).toContain('src/controllers/user.ts');
      expect(files).not.toContain('node_modules/router/index.js');
    });

    it('returns empty array for no stack traces', () => {
      const issue = 'The login button does not work when clicked.';
      const files = parseStackTraces(issue);
      expect(files).toEqual([]);
    });

    it('deduplicates files', () => {
      const issue = `
Error at src/main.ts:10:5
Error at src/main.ts:20:5
Error at src/main.ts:30:5
`;
      const files = parseStackTraces(issue);
      expect(files.filter((f) => f === 'src/main.ts')).toHaveLength(1);
    });
  });

  describe('extractKeyTerms', () => {
    it('extracts error class names', () => {
      const issue = 'Getting AuthenticationError when trying to login';
      const terms = extractKeyTerms(issue);
      expect(terms).toContain('AuthenticationError');
    });

    it('extracts function names from backticks', () => {
      const issue = 'The `validateUser()` function returns undefined';
      const terms = extractKeyTerms(issue);
      expect(terms).toContain('validateUser');
    });

    it('extracts class names', () => {
      const issue = 'Bug in `UserService` class';
      const terms = extractKeyTerms(issue);
      expect(terms).toContain('UserService');
    });
  });

  describe('localizeToFiles', () => {
    const mockCodemap: Codemap = {
      version: 1,
      entries: [
        {
          path: 'src/auth/login.ts',
          kind: 'source',
          lines: 100,
          symbols: ['function login', 'class AuthService'],
        },
        {
          path: 'src/auth/token.ts',
          kind: 'source',
          lines: 50,
          symbols: ['function validateToken'],
        },
        { path: 'src/utils/helper.ts', kind: 'source', lines: 30, symbols: ['function format'] },
        { path: 'test/auth.test.ts', kind: 'test', lines: 200, symbols: [] },
        { path: 'README.md', kind: 'doc', lines: 50, symbols: [] },
      ],
    };

    it('prioritizes files from stack traces', () => {
      const files = localizeToFiles({
        issue: 'Error at src/auth/login.ts:42',
        root: '/tmp/repo',
        codemap: mockCodemap,
        config: {
          enabled: true,
          localization: 'hierarchical',
          localize_top_files: 3,
          localize_top_elements: 5,
          skeleton_max_tokens: 12000,
          require_reproduction: true,
          reproduction_max_attempts: 3,
          reproduction_models: 'planner',
          fail_to_pass_gate: true,
          pass_to_pass_gate: true,
          patch_context_lines: 3,
          max_repair_rounds: 6,
          parse_stack_traces: true,
          disable_beyond: true,
          candidate_patches: 0,
        },
      });

      expect(files[0]).toBe('src/auth/login.ts');
    });

    it('ranks files by keyword relevance', () => {
      const files = localizeToFiles({
        issue: 'The validateToken function has a bug',
        root: '/tmp/repo',
        codemap: mockCodemap,
        config: {
          enabled: true,
          localization: 'hierarchical',
          localize_top_files: 3,
          localize_top_elements: 5,
          skeleton_max_tokens: 12000,
          require_reproduction: true,
          reproduction_max_attempts: 3,
          reproduction_models: 'planner',
          fail_to_pass_gate: true,
          pass_to_pass_gate: true,
          patch_context_lines: 3,
          max_repair_rounds: 6,
          parse_stack_traces: true,
          disable_beyond: true,
          candidate_patches: 0,
        },
      });

      expect(files).toContain('src/auth/token.ts');
    });

    it('prefers source over test files', () => {
      const files = localizeToFiles({
        issue: 'auth module has a bug',
        root: '/tmp/repo',
        codemap: mockCodemap,
        config: {
          enabled: true,
          localization: 'hierarchical',
          localize_top_files: 5,
          localize_top_elements: 5,
          skeleton_max_tokens: 12000,
          require_reproduction: true,
          reproduction_max_attempts: 3,
          reproduction_models: 'planner',
          fail_to_pass_gate: true,
          pass_to_pass_gate: true,
          patch_context_lines: 3,
          max_repair_rounds: 6,
          parse_stack_traces: true,
          disable_beyond: true,
          candidate_patches: 0,
        },
      });

      const sourceIdx = files.indexOf('src/auth/login.ts');
      const testIdx = files.indexOf('test/auth.test.ts');
      if (testIdx !== -1) {
        expect(sourceIdx).toBeLessThan(testIdx);
      }
    });
  });

  describe('renderLocalization', () => {
    it('renders localization result', () => {
      const result = {
        files: ['src/auth.ts', 'src/user.ts'],
        elements: [
          { file: 'src/auth.ts', name: 'login', kind: 'function', startLine: 10, endLine: 20 },
        ],
        lines: [],
        skeletons: [],
      };

      const rendered = renderLocalization(result, 10000);
      expect(rendered).toContain('Fault Localization');
      expect(rendered).toContain('src/auth.ts');
      expect(rendered).toContain('src/user.ts');
    });
  });
});
