import { describe, expect, it } from 'vitest';
import {
  checkBrowserToolPolicy,
  checkMcpToolPolicy,
  checkWorkerWorktreePolicy,
} from '../../../src/security/policy-extra.js';

describe('policy-extra: extended security controls', () => {
  describe('checkBrowserToolPolicy', () => {
    it('disallows evaluate/eval by default', () => {
      expect(checkBrowserToolPolicy('evaluate')).toMatchObject({
        allowed: false,
        rule: 'browser-eval-disabled',
      });
      expect(checkBrowserToolPolicy('eval')).toMatchObject({
        allowed: false,
        rule: 'browser-eval-disabled',
      });
      expect(checkBrowserToolPolicy('execute_script')).toMatchObject({
        allowed: false,
        rule: 'browser-eval-disabled',
      });
    });

    it('allows evaluate when explicitly enabled', () => {
      expect(checkBrowserToolPolicy('evaluate', { allowEval: true })).toEqual({
        allowed: true,
      });
    });

    it('allows safe browser actions', () => {
      expect(checkBrowserToolPolicy('open')).toEqual({ allowed: true });
      expect(checkBrowserToolPolicy('click')).toEqual({ allowed: true });
      expect(checkBrowserToolPolicy('snapshot')).toEqual({ allowed: true });
      expect(checkBrowserToolPolicy('screenshot')).toEqual({ allowed: true });
    });
  });

  describe('checkMcpToolPolicy', () => {
    it('disallows destructive MCP tool calls without policy approval', () => {
      expect(checkMcpToolPolicy('mcp__db__drop_database', { destructive: true })).toMatchObject({
        allowed: false,
        rule: 'mcp-destructive-unapproved',
      });

      expect(
        checkMcpToolPolicy('mcp__fs__delete_all', {
          annotations: { destructive: true },
        }),
      ).toMatchObject({
        allowed: false,
        rule: 'mcp-destructive-unapproved',
      });
    });

    it('allows destructive MCP tool calls when explicitly approved', () => {
      expect(
        checkMcpToolPolicy(
          'mcp__db__drop_database',
          { destructive: true },
          { allowDestructiveMcp: true },
        ),
      ).toEqual({ allowed: true });
    });

    it('allows non-destructive MCP tool calls', () => {
      expect(checkMcpToolPolicy('mcp__fs__read_file', {})).toEqual({ allowed: true });
    });
  });

  describe('checkWorkerWorktreePolicy', () => {
    const runHome = '/Users/yaeger/.omnexx';
    const repoRoot = '/Users/yaeger/Projects/app';

    it('denies workers running in the primary repo root', () => {
      expect(checkWorkerWorktreePolicy(repoRoot, repoRoot, runHome)).toMatchObject({
        allowed: false,
        rule: 'worker-not-in-worktree',
      });
    });

    it('allows workers running in an isolated worktree under runHome', () => {
      const wt = `${runHome}/worktrees/run123-w-aider`;
      expect(checkWorkerWorktreePolicy(wt, repoRoot, runHome)).toEqual({
        allowed: true,
      });
    });

    it('denies workers running outside allowed home hierarchy', () => {
      expect(checkWorkerWorktreePolicy('/tmp/random', repoRoot, runHome)).toMatchObject({
        allowed: false,
        rule: 'worker-worktree-outside-home',
      });
    });
  });
});
