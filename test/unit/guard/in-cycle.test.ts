import { describe, expect, it } from 'vitest';
import { burnThreshold, InCycleWatch, isInCycleSignal } from '../../../src/guard/stuck.js';

const limits = { repeatedToolCall: 3, noEditTurns: 4, burnTokens: undefined };
const read = (path: string) => ({ name: 'read', input: { path } });

describe('InCycleWatch', () => {
  it('flags the same call with the same arguments, not different arguments', () => {
    const w = new InCycleWatch(limits, () => 0);
    expect(w.afterTurn(1, 0, [read('a'), read('b')])).toBeUndefined();
    expect(w.afterTurn(2, 0, [read('a')])).toBeUndefined();
    expect(w.afterTurn(3, 0, [read('a')])).toMatchObject({ signal: 'repeated_tool_call' });
  });

  it('an edit between repeats resets the count: read, edit, read again is normal work', () => {
    let edits = 0;
    const w = new InCycleWatch(limits, () => edits);
    expect(w.afterTurn(1, 0, [read('src/paginate.js')])).toBeUndefined();
    edits = 1;
    expect(w.afterTurn(2, 0, [read('src/paginate.js')])).toBeUndefined();
    edits = 2;
    expect(w.afterTurn(3, 0, [read('src/paginate.js')])).toBeUndefined();
    expect(w.afterTurn(4, 0, [read('src/paginate.js')])).toBeUndefined();
    // Three in a row with nothing changing in between is the loop.
    expect(w.afterTurn(5, 0, [read('src/paginate.js')])).toMatchObject({
      signal: 'repeated_tool_call',
    });
  });

  it('flags K turns without an edit, and an edit resets the count', () => {
    let edits = 0;
    const w = new InCycleWatch({ ...limits, repeatedToolCall: 99 }, () => edits);
    for (let t = 1; t <= 3; t++) expect(w.afterTurn(t, 0, [read(`f${t}`)])).toBeUndefined();
    edits = 1;
    expect(w.afterTurn(4, 0, [read('x')])).toBeUndefined();
    for (let t = 5; t <= 7; t++) expect(w.afterTurn(t, 0, [read(`g${t}`)])).toBeUndefined();
    expect(w.afterTurn(8, 0, [read('y')])).toMatchObject({
      signal: 'no_edits',
      detail: '4 turns without editing a file',
    });
  });

  it('flags token burn only before the first edit', () => {
    let edits = 0;
    const w = new InCycleWatch({ ...limits, noEditTurns: 99, burnTokens: 1_000 }, () => edits);
    expect(w.afterTurn(1, 900, [])).toBeUndefined();
    expect(w.afterTurn(2, 1_200, [])).toMatchObject({ signal: 'token_burn' });
    edits = 1;
    expect(w.afterTurn(3, 5_000, [])).toBeUndefined();
  });

  it('identical calls with different results are checking, not a loop', () => {
    const w = new InCycleWatch({ ...limits, noEditTurns: 99 }, () => 0);
    const call = (result: string) => ({ name: 'read', input: { path: 'a' }, result });
    expect(w.afterTurn(1, 0, [call('v1')])).toBeUndefined();
    expect(w.afterTurn(2, 0, [call('v2')])).toBeUndefined();
    expect(w.afterTurn(3, 0, [call('v3')])).toBeUndefined();
    expect(w.afterTurn(4, 0, [call('v4')])).toBeUndefined();
  });

  it('identical calls with identical results still trip at N', () => {
    const w = new InCycleWatch({ ...limits, noEditTurns: 99 }, () => 0);
    const call = () => ({ name: 'read', input: { path: 'a' }, result: 'same' });
    expect(w.afterTurn(1, 0, [call()])).toBeUndefined();
    expect(w.afterTurn(2, 0, [call()])).toBeUndefined();
    expect(w.afterTurn(3, 0, [call()])).toMatchObject({ signal: 'repeated_tool_call' });
  });

  it('errored calls do not count: a retry after failure is recovery, not a loop', () => {
    const w = new InCycleWatch({ ...limits, noEditTurns: 99 }, () => 0);
    const failed = { name: 'bash', input: { command: 'make' }, result: 'boom', isError: true };
    expect(w.afterTurn(1, 0, [failed])).toBeUndefined();
    expect(w.afterTurn(2, 0, [failed])).toBeUndefined();
    expect(w.afterTurn(3, 0, [failed])).toBeUndefined();
    // And the retry that then succeeds starts its own streak.
    const ok = { name: 'bash', input: { command: 'make' }, result: 'ok' };
    expect(w.afterTurn(4, 0, [ok])).toBeUndefined();
    expect(w.afterTurn(5, 0, [ok])).toBeUndefined();
    expect(w.afterTurn(6, 0, [ok])).toMatchObject({ signal: 'repeated_tool_call' });
  });
});

describe('burnThreshold', () => {
  it('needs 3 cycles of history and uses the median', () => {
    expect(burnThreshold([10, 20], 3)).toBeUndefined();
    expect(burnThreshold([10, 1_000, 20], 3)).toBe(60);
    expect(burnThreshold([10, 20, 30, 40], 2)).toBe(50);
  });
  it('recognizes in-cycle signals', () => {
    expect(isInCycleSignal('no_edits')).toBe(true);
    expect(isInCycleSignal('oscillation')).toBe(false);
  });
});
