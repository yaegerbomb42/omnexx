import { describe, expect, it } from 'vitest';
import {
  extractFilesTouched,
  extractVerificationCommand,
  foldMilestoneCheckpoint,
  formatMilestoneRecap,
  type CheckpointMetadata,
} from '../../../src/agent/milestone-compactor.js';
import type { Message } from '../../../src/providers/types.js';

describe('formatMilestoneRecap', () => {
  it('formats a 3-line structured milestone recap', () => {
    const meta: CheckpointMetadata = {
      milestoneId: 'M1',
      summary: 'added token cache pinning to Anthropic provider',
      filesTouched: ['src/providers/anthropic.ts', 'test/unit/providers/anthropic.test.ts'],
      verificationCheck: 'npm test -- -t "cache prefix"',
      commitSha: 'a1b2c3d4e5f6',
    };

    const recap = formatMilestoneRecap(meta);
    const lines = recap.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'Milestone M1 complete [a1b2c3d]: added token cache pinning to Anthropic provider',
    );
    expect(lines[1]).toBe(
      '- Changed: src/providers/anthropic.ts, test/unit/providers/anthropic.test.ts',
    );
    expect(lines[2]).toBe('- Verified via: npm test -- -t "cache prefix"');
  });

  it('handles empty touched files cleanly', () => {
    const meta: CheckpointMetadata = {
      milestoneId: 'M2',
      summary: 'verified existing behavior without changes',
      filesTouched: [],
      verificationCheck: 'npm test',
    };

    const lines = formatMilestoneRecap(meta).split('\n');
    expect(lines[1]).toBe('- Changed: none');
  });
});

describe('extractFilesTouched & extractVerificationCommand', () => {
  it('extracts files touched and verification command from message tool calls', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'goal: add feature' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'read',
            input: { path: 'src/config.ts' },
          },
          {
            type: 'tool_use',
            id: 't2',
            name: 'write_file',
            input: { path: 'src/feature.ts', content: 'code' },
          },
          {
            type: 'tool_use',
            id: 't3',
            name: 'bash',
            input: { command: 'npx vitest run test/feature.test.ts' },
          },
        ],
      },
    ];

    expect(extractFilesTouched(messages)).toEqual(['src/config.ts', 'src/feature.ts']);
    expect(extractVerificationCommand(messages)).toBe('npx vitest run test/feature.test.ts');
  });
});

describe('foldMilestoneCheckpoint', () => {
  it('folds 10 intermediate turns into a 3-line milestone recap and frees >70% tokens', () => {
    // Construct 10 turns of trial-and-error discussion with large mock outputs
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'System Goal: implement login authentication' }],
      },
    ];

    for (let i = 1; i <= 10; i++) {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Turn ${i}: trying hypothesis ${i} with trial-and-error debugging and verbose logging...`,
          },
          {
            type: 'tool_use',
            id: `call_${i}`,
            name: i % 2 === 0 ? 'write_file' : 'bash',
            input: i % 2 === 0 ? { path: 'src/auth.ts' } : { command: 'npm test' },
          },
        ],
      });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: `call_${i}`,
            content:
              `Verbose test trace output line 1\nVerbose test trace output line 2\nStack trace: Error at Turn ${i} in file.ts:100\n`.repeat(
                15,
              ),
          },
        ],
      });
    }

    const meta: CheckpointMetadata = {
      milestoneId: 'M1',
      summary: 'implemented authentication middleware and token verification',
      filesTouched: ['src/auth.ts', 'test/auth.test.ts'],
      verificationCheck: 'npm test -- -t "auth"',
      commitSha: 'c0ffeec0ffee',
    };

    const res = foldMilestoneCheckpoint(messages, meta, { maxTurnsToFold: 10 });

    expect(res.foldedTurns).toBe(10);
    expect(res.tokensBefore).toBeGreaterThan(1_500);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore * 0.3); // >70% token reduction
    expect(res.reductionPercentage).toBeGreaterThanOrEqual(70);

    // Initial message preserved
    expect(res.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: 'System Goal: implement login authentication',
    });

    // Checkpoint folded message contains 3-line structured recap
    const recapBlock = res.messages[1]?.content[0];
    expect(recapBlock?.type).toBe('text');
    if (recapBlock?.type === 'text') {
      expect(recapBlock.text).toContain('[CHECKPOINT FOLD]');
      expect(recapBlock.text).toContain(
        'Milestone M1 complete [c0ffeec]: implemented authentication middleware',
      );
      expect(recapBlock.text).toContain('- Changed: src/auth.ts, test/auth.test.ts');
      expect(recapBlock.text).toContain('- Verified via: npm test -- -t "auth"');
    }
  });

  it('handles short conversation histories safely without folding', () => {
    const shortMessages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'goal' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];

    const meta: CheckpointMetadata = {
      milestoneId: 'M1',
      summary: 'done',
      filesTouched: [],
      verificationCheck: 'npm test',
    };

    const res = foldMilestoneCheckpoint(shortMessages, meta);
    expect(res.foldedTurns).toBe(0);
    expect(res.messages).toHaveLength(2);
  });
});
