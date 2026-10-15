import { describe, expect, it } from 'vitest';
import { readAgentSettings } from '../../../src/config/agent-settings.js';
import { DEFAULT_LEVELS } from '../../../src/core/agent-levels.js';
import { resolvePaths } from '../../../src/core/paths.js';
import {
  agentPanelKeyOf,
  panelKey,
  panelLines,
  type AgentPanelState,
  type PanelKey,
} from '../../../src/tui/agent-panel.js';
import { AgentSettingsHost } from '../../../src/tui/agent-settings-host.js';
import { isolatedEnv } from '../../support/tmp.js';

const start: AgentPanelState = {
  focus: 0,
  levels: DEFAULT_LEVELS,
  askOnStart: true,
  startup: true,
};

/** Press keys in order; the state after the last one (or the closing result). */
function press(s: AgentPanelState, ...keys: PanelKey[]) {
  let state = s;
  for (const k of keys) {
    const r = panelKey(state, k);
    if (r.kind !== 'open') return r;
    state = r.state;
  }
  return { kind: 'open' as const, state };
}

describe('/settings panel keys', () => {
  it('Tab and Shift-Tab move between rows, wrapping', () => {
    expect(press(start, { next: true })).toMatchObject({ state: { focus: 1 } });
    expect(press(start, { prev: true })).toMatchObject({ state: { focus: 5 } });
  });

  it('←/→ change the focused value within its range', () => {
    const up = press(start, { right: true }, { right: true });
    expect(up).toMatchObject({ state: { levels: { taskEffort: 7 } } });
    const floor = press(start, ...Array.from({ length: 12 }, () => ({ left: true })));
    expect(floor).toMatchObject({ state: { levels: { taskEffort: 1 } } });
    const ctx = press(start, { next: true }, { next: true }, { right: true });
    expect(ctx).toMatchObject({ state: { levels: { contextLevel: 7 } } });
    const time = press(start, { prev: true }, { prev: true }, { prev: true }, { right: true });
    expect(time).toMatchObject({ state: { levels: { time: '4h' } } });
    const tokens = press(start, { prev: true }, { prev: true }, { left: true });
    expect(tokens).toMatchObject({ state: { levels: { maxTokens: 8_192 } } });
    const ask = press(start, { prev: true }, { right: true });
    expect(ask).toMatchObject({ state: { askOnStart: false } });
  });

  it('Enter saves, Esc cancels', () => {
    expect(press(start, { right: true }, { enter: true })).toMatchObject({
      kind: 'save',
      state: { levels: { taskEffort: 6 } },
    });
    expect(press(start, { right: true }, { escape: true })).toEqual({ kind: 'cancel' });
  });

  it('reads terminal keys', () => {
    expect(agentPanelKeyOf('', { tab: true })).toEqual({ next: true });
    expect(agentPanelKeyOf('', { tab: true, shift: true })).toEqual({ prev: true });
    expect(agentPanelKeyOf('', { leftArrow: true })).toEqual({ left: true });
    expect(agentPanelKeyOf('l', {})).toEqual({ right: true });
    expect(agentPanelKeyOf('', { return: true })).toEqual({ enter: true });
    expect(agentPanelKeyOf('', { escape: true })).toEqual({ escape: true });
  });

  it('shows the meaning of each level in one line', () => {
    const r = press(start, { left: true }, { left: true });
    const lines = r.kind === 'cancel' ? [] : panelLines(r.state);
    expect(lines[0]?.value).toBe('3 · small focused change, light planning');
    expect(lines[2]?.value).toBe('96k · roomy');
    expect(lines[5]?.value).toBe('ask again next launch');
  });
});

describe('the launch offer', () => {
  it('opens until the person picks "don\'t ask again", which is saved', async () => {
    const paths = resolvePaths(await isolatedEnv());
    const host = new AgentSettingsHost(paths, () => undefined);
    expect(await host.offerAtStart()).toBe(true);
    expect(host.panel?.startup).toBe(true);
    // Move to "at start", flip it, accept.
    await host.key({ prev: true });
    await host.key({ right: true });
    const closed = await host.key({ enter: true });
    expect(closed).toMatchObject({ saved: true });
    expect(closed?.text).toMatch(/not asking at launch/);
    expect(host.summary).toBe('effort 5/5 · ctx 96k · 2h');
    expect((await readAgentSettings(paths)).askOnStart).toBe(false);

    const next = new AgentSettingsHost(paths, () => undefined);
    expect(await next.offerAtStart()).toBe(false);
    expect(next.panel).toBeUndefined();
  });

  it('asks again next launch when kept on, and Esc saves nothing', async () => {
    const paths = resolvePaths(await isolatedEnv());
    const host = new AgentSettingsHost(paths, () => undefined);
    await host.offerAtStart();
    expect(await host.key({ escape: true })).toEqual({
      text: 'agent settings unchanged',
      saved: false,
    });
    expect((await readAgentSettings(paths)).levels).toBeUndefined();
    await host.offerAtStart();
    await host.key({ enter: true });
    expect(await new AgentSettingsHost(paths, () => undefined).offerAtStart()).toBe(true);
  });
});
