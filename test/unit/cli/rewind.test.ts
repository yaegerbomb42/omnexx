import { expect, it } from 'vitest';
import { parseRestoreChoice } from '../../../src/cli/rewind.js';

it('code restores files only and keeps the conversation', () => {
  expect(parseRestoreChoice('code', true)).toEqual({ conversation: false, files: true });
});

it('both and conversation resolve to their scopes', () => {
  expect(parseRestoreChoice('both', true)).toEqual({ conversation: true, files: true });
  expect(parseRestoreChoice('conversation', true)).toEqual({ conversation: true, files: false });
});

it('cancel and unrecognised input are rejected', () => {
  expect(parseRestoreChoice('cancel', true)).toBe('cancel');
  expect(parseRestoreChoice('foo', true)).toBeUndefined();
});

it('legacy Y/N still fires when checkpointing is off', () => {
  expect(parseRestoreChoice('y', false)).toEqual({ conversation: true, files: false });
  expect(parseRestoreChoice('yes', false)).toEqual({ conversation: true, files: false });
  expect(parseRestoreChoice('n', false)).toBe('cancel');
  expect(parseRestoreChoice('', false)).toBeUndefined();
});
