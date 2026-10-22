import { describe, expect, it } from 'vitest';
import {
  ScratchpadVersionError,
  SharedScratchpad,
  type ScratchpadChange,
} from '../../../src/workers/scratchpad.js';

describe('SharedScratchpad entries', () => {
  it('puts, gets, lists and deletes within a namespace', () => {
    const pad = new SharedScratchpad();
    pad.put('spec', 'a', { n: 1 });
    pad.put('spec', 'b', { n: 2 });
    pad.put('impl', 'a', 'other namespace');

    expect(pad.get('spec', 'a')).toEqual({ n: 1 });
    expect(pad.get('spec', 'missing')).toBeUndefined();
    expect(pad.get('nope', 'a')).toBeUndefined();
    expect(pad.list('spec')).toEqual(['a', 'b']);
    expect(pad.list('nope')).toEqual([]);

    expect(pad.delete('spec', 'a')).toBe(true);
    expect(pad.delete('spec', 'a')).toBe(false);
    expect(pad.get('spec', 'a')).toBeUndefined();
    // Namespaces are independent: impl/a survived the spec/a delete.
    expect(pad.get('impl', 'a')).toBe('other namespace');
  });

  it('versions every write and reports 0 for absent entries', () => {
    const pad = new SharedScratchpad();
    expect(pad.version('spec', 'a')).toBe(0);
    expect(pad.put('spec', 'a', 'one')).toBe(1);
    expect(pad.put('spec', 'a', 'two')).toBe(2);
    expect(pad.version('spec', 'a')).toBe(2);
    expect(pad.getEntry('spec', 'a')?.value).toBe('two');
    pad.delete('spec', 'a');
    expect(pad.version('spec', 'a')).toBe(0);
  });

  it('putIfVersion claims an absent key and fails on a stale version', () => {
    const pad = new SharedScratchpad();
    expect(pad.putIfVersion('locks', 'owner', 'me', 0)).toBe(1);
    // Second claim at the same expected version loses the race.
    expect(() => pad.putIfVersion('locks', 'owner', 'someone else', 0)).toThrow(
      ScratchpadVersionError,
    );
    try {
      pad.putIfVersion('locks', 'owner', 'someone else', 0);
    } catch (err) {
      expect(err).toBeInstanceOf(ScratchpadVersionError);
      const verr = err as ScratchpadVersionError;
      expect(verr.expected).toBe(0);
      expect(verr.actual).toBe(1);
    }
    // The current version succeeds and advances.
    expect(pad.putIfVersion('locks', 'owner', 'me again', 1)).toBe(2);
    expect(pad.get('locks', 'owner')).toBe('me again');
  });
});

describe('SharedScratchpad event log', () => {
  it('appends with monotonic sequence numbers and injected timestamps', () => {
    let t = 1_000;
    const pad = new SharedScratchpad({ now: () => ++t });
    const first = pad.append({ ns: 'spec', key: 'M1', kind: 'phase-output' });
    const second = pad.append({ ns: 'impl', key: 'M1', kind: 'phase-output', note: 'done' });
    const third = pad.append({ ns: 'audit', key: 'M1', kind: 'verdict', note: 'pass' });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect([first.at, second.at, third.at]).toEqual([1001, 1002, 1003]);
    expect(pad.events().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(pad.events(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(pad.events(3)).toEqual([]);
  });
});

describe('SharedScratchpad subscriptions', () => {
  it('notifies subscribers of puts, deletes and appends until unsubscribed', () => {
    const pad = new SharedScratchpad();
    const changes: ScratchpadChange[] = [];
    const off = pad.subscribe((c) => changes.push(c));

    pad.put('spec', 'M1', { title: 'x' });
    pad.append({ ns: 'spec', key: 'M1', kind: 'phase-output' });
    pad.delete('spec', 'M1');
    off();
    pad.put('spec', 'M2', { title: 'unseen' });

    expect(changes.map((c) => c.type)).toEqual(['put', 'append', 'delete']);
    const put = changes[0];
    expect(put?.type).toBe('put');
    if (put?.type === 'put') expect(put.version).toBe(1);
  });
});
