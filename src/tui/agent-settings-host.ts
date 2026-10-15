import {
  readAgentSettings,
  writeAgentSettings,
  type StoredAgentSettings,
} from '../config/agent-settings.js';
import { DEFAULT_LEVELS, levelsSummary } from '../core/agent-levels.js';
import type { OmnexxPaths } from '../core/paths.js';
import { panelKey, type AgentPanelState, type PanelKey } from './agent-panel.js';

/**
 * The agent sliders inside an interactive session (terminal UI and the editor's chat server):
 * the saved settings, the open `/settings` panel, and the offer at launch. Saving writes
 * agent-settings.json; the next config load (a new chat, run or message) picks it up.
 */
export class AgentSettingsHost {
  panel: AgentPanelState | undefined;
  private stored: StoredAgentSettings = { levels: undefined, askOnStart: true };

  constructor(
    private readonly paths: OmnexxPaths,
    private readonly changed: () => void,
  ) {}

  async load(): Promise<StoredAgentSettings> {
    this.stored = await readAgentSettings(this.paths);
    return this.stored;
  }

  get settings(): StoredAgentSettings {
    return this.stored;
  }

  /** "effort 6/4 · ctx 64k · 30m" once levels are saved. */
  get summary(): string | undefined {
    return this.stored.levels ? levelsSummary(this.stored.levels) : undefined;
  }

  open(startup: boolean): void {
    this.panel = {
      focus: 0,
      levels: this.stored.levels ?? DEFAULT_LEVELS,
      askOnStart: this.stored.askOnStart,
      startup,
    };
    this.changed();
  }

  /** At launch: open the panel when the person asked to be asked. True when it opened. */
  async offerAtStart(): Promise<boolean> {
    const s = await this.load();
    if (!s.askOnStart) return false;
    this.open(true);
    return true;
  }

  /** Save settings directly (the editor's card). */
  async save(next: StoredAgentSettings): Promise<StoredAgentSettings> {
    this.stored = await writeAgentSettings(this.paths, next);
    this.changed();
    return this.stored;
  }

  /** A key while the panel is open; when it closed, a line to show and whether it saved. */
  async key(k: PanelKey): Promise<{ text: string; saved: boolean } | undefined> {
    if (!this.panel) return undefined;
    const r = panelKey(this.panel, k);
    if (r.kind === 'open') {
      this.panel = r.state;
      this.changed();
      return undefined;
    }
    this.panel = undefined;
    if (r.kind === 'cancel') {
      this.changed();
      return { text: 'agent settings unchanged', saved: false };
    }
    const saved = await this.save({ levels: r.state.levels, askOnStart: r.state.askOnStart });
    const ask = saved.askOnStart ? 'asking again next launch' : 'not asking at launch (/settings)';
    return { text: `agent settings: ${this.summary ?? ''} · ${ask}`, saved: true };
  }
}
