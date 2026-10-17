/** The composer's suggestion list in the DOM; ranking and triggers live in `suggest.ts`. */
import { escapeHtml } from './render.js';
import { rankCommands, rankFiles, triggerAt, type SlashCommand } from './suggest.js';

export interface SuggestHost {
  input: HTMLTextAreaElement;
  box: HTMLElement;
  files: () => readonly string[];
  requestFiles: () => void;
  runCommand: (c: SlashCommand) => void;
}

interface Item {
  label: string;
  hint: string;
  pick: () => void;
}

export function attachSuggest(h: SuggestHost): {
  onKey: (e: KeyboardEvent) => boolean;
  refresh: () => void;
} {
  let items: Item[] = [];
  let active = 0;
  let asked = false;

  const close = (): void => {
    items = [];
    h.box.hidden = true;
  };

  const draw = (): void => {
    h.box.hidden = items.length === 0;
    h.box.innerHTML = items
      .map(
        (it, i) =>
          `<div class="sg-item${i === active ? ' on' : ''}" role="option" aria-selected="${String(i === active)}" data-sg="${String(i)}"><span class="sg-label">${escapeHtml(it.label)}</span><span class="sg-hint">${escapeHtml(it.hint)}</span></div>`,
      )
      .join('');
  };

  const replaceToken = (start: number, text: string): void => {
    const caret = h.input.selectionStart;
    const v = h.input.value;
    h.input.value = v.slice(0, start) + text + v.slice(caret);
    const at = start + text.length;
    h.input.setSelectionRange(at, at);
    h.input.dispatchEvent(new Event('input'));
    h.input.focus();
  };

  const refresh = (): void => {
    const t = triggerAt(h.input.value, h.input.selectionStart);
    if (!t) {
      close();
      return;
    }
    if (t.kind === 'command') {
      items = rankCommands(t.query).map((c) => ({
        label: `/${c.name}`,
        hint: c.hint,
        pick: () => {
          h.input.value = '';
          h.input.dispatchEvent(new Event('input'));
          close();
          h.runCommand(c);
        },
      }));
    } else {
      if (!asked) {
        asked = true;
        h.requestFiles();
      }
      items = rankFiles(h.files(), t.query).map((f) => ({
        label: f.slice(f.lastIndexOf('/') + 1),
        hint: f,
        pick: () => {
          close();
          replaceToken(t.start, `@${f} `);
        },
      }));
    }
    active = Math.min(active, Math.max(items.length - 1, 0));
    draw();
  };

  h.box.addEventListener('mousedown', (e) => {
    const i = (e.target as Element | null)?.closest<HTMLElement>('[data-sg]')?.dataset.sg;
    if (i === undefined) return;
    e.preventDefault();
    items[Number(i)]?.pick();
  });

  const onKey = (e: KeyboardEvent): boolean => {
    if (h.box.hidden || !items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      draw();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      items[active]?.pick();
    } else if (e.key === 'Escape') {
      close();
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  return { onKey, refresh };
}
