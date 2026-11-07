# Omnexx VS Code UI Overhaul — Design

Branch: `feat/ui-overhaul` · Base: `23a2a40` · Date: 2026-11-06

## 1. Goal

Rewrite the extension UI custom and organized: one calm, minimal surface where
chat is primary and everything else is one click away. Keep **all** functionality —
every message type, setting, picker, and panel still works. This is a
rewrite/reorganization, not a feature cut.

## 2. What exists today (survey summary)

- One webview, one bundled script (`out/chat.js`). `chat.ts` (1100 lines) is the
  orchestrator: owns `State`, the message dispatcher, the composer, the
  conversation renderer. ~28 modules delegate from it (`render.ts` is the shared
  DOM-free util hub).
- `chatView.ts` (764 lines) is the host: builds the HTML shell, forwards 45
  message types verbatim to `omnexx chat-server` (`FORWARD` set), handles the
  rest itself (clipboard, file open, QuickPick, config writes).
- `chat.css` (3072 lines) already has a real token system (~75 custom
  properties: spacing, type, radii, durations, palette, glass, shadows).
  `settings.css` (2052 lines) defines exactly one token (`--sec`) and inherits
  the rest — load order is a hard dependency.
- Duplication found: model picking ×3, execution mode ×3, context surfaces ×3,
  stats ×3, badges ×2, empty states ×3. Dead code: `refreshCockpit`,
  `settingsLayout.navHtml`, the posture `experimental` gate (stored, never
  applied), slash commands `fix` / `toggleBrowser` (posted, never handled).
- CSS duplication: the Kernel card is styled in full in both files;
  `.mp-custom-entry` duplicated; `.composer`/`.input-wrap` defined 3× in
  chat.css; "polish" appendices from different agents re-tune the same
  surfaces.

## 3. Design system (single layer)

New file `vscode/media/tokens.css`, loaded **first**, before chat.css and
settings.css. It owns every token; the other two files consume tokens and
contain only component rules.

- **Spacing:** `--space-1..8` (2/4/6/8/14/20/28/40px) — keep the existing
  scale, it works. One gutter `--pad-x: 14px`.
- **Type:** `--fs-xs/sm/md/lg` derived from `--vscode-font-size` (×0.85/0.92/
  1/1.08). No hardcoded px font sizes anywhere; no `rem` sizes.
- **Radii:** `--radius-xs/sm/md/lg/full` (3/6/8/12/999px).
- **Motion:** `--dur-fast/base/slow/fade` (140/220/340/700ms), `--ease`,
  `--ease-soft`, `--ease-spring`. Animations are subtle: fades and 4px slides
  only. Respect `prefers-reduced-motion`.
- **Color:** all semantic colors resolve through `var(--vscode-*)` with hex
  fallbacks. One accent (`--accent`), one semantic set
  (`--ok/--warn/--bad`), one muted text (`--muted`). Kill the hardcoded
  bright set in settings.css (`#36c5f0`, `#38bdf8`, …) — replace with tokens.
- **Surfaces:** `--surface` (sidebar bg), `--card` (8% fg mix), `--line`
  (16% fg mix). One card style, one border style. No glass/noise/sparkle
  variants — the glassmorphic treatment is the clutter. Flat, calm, one
  elevation (`--shadow-md`) used sparingly (popovers only).
- **Rule:** no `color-mix` with magic percentages outside tokens; no new hex
  literals; every component rule references a token.

## 4. Component hierarchy

Keep the module files (they map well to features) but enforce a strict layering:

```
chat.ts            orchestrator only: state, dispatch, composer, conversation
  ├─ render.ts     pure rendering core (no DOM, no messages) — unchanged API
  ├─ design/       NEW: tokens.css + shared primitives (button, pill, card, meter)
  ├─ chat/         messages, think accordion, tool clusters, working HUD, empty state
  ├─ panels/       settings, inspector, context page, model picker (overlays)
  └─ widgets/      stats, crew, mcp, skills, browser cockpit, suggest
```

Rules:

- A module may import `render.ts` and design primitives. It may NOT import
  another feature module (today settings.ts imports roles/mcp/skills — move
  that wiring into chat.ts).
- Every panel exposes the same shape: `html()`, `open()`, `close()`,
  `onMessage(msg)`, `wire(post)`. Panels that already have this shape keep it.
- `chat.ts` keeps owning `State` and the dispatcher; panels receive state
  slices, they don't read global state.

## 5. Layout — minimal, one primary surface

The panel is a chat. Everything else is a layer above it or a drawer.

```
┌─────────────────────────────────────┐
│ (VS Code title bar: New · Model ·   │
│  Context · Settings — unchanged)    │
├─────────────────────────────────────┤
│ mission timeline (collapsed)        │  ← only when a run is active
│ posture + domain (one quiet row)    │  ← single row, small pills
├─────────────────────────────────────┤
│                                     │
│   conversation (the whole panel)    │  ← primary; nothing competes
│                                     │
├─────────────────────────────────────┤
│ statusline: model · tokens · ctx    │  ← one thin line, muted
│ ┌─────────────────────────────────┐ │
│ │ composer (autosize, 1 button)   │ │  ← Send/Stop only; mode is a
│ └─────────────────────────────────┘ │     small segmented control
└─────────────────────────────────────┘
```

- **Primary:** conversation + composer. Nothing else is visible by default.
- **Secondary (one click, overlay or drawer):** Settings, Context Cockpit,
  Context page, Model picker, Browser cockpit, Crew, Stats. Each opens as a
  full-panel overlay with a single close action (Esc / × / back).
- **Hidden behind a toggle:** kernel card (only when kernel allocates),
  browser cockpit (only during browser runs), crew (only when helpers exist),
  memory note (collapsible), think accordions (collapsed by default when not
  streaming).
- **Removed from the default view:** the welcome quick-start cards move into
  the empty state (already there — delete the duplicate hardcoded buttons in
  chatView.html); the mission timeline collapses to one line when idle.

## 6. Unification (kill the ×3s)

- **Model picking:** one source of truth — `modelPicker.ts` owns the popover
  and the current model. Settings and roles call `modelPicker.open()`
  instead of rendering their own pickers. One `setCurrent` path.
- **Execution mode:** one module — `posture.ts` owns the 3 modes and their
  captions. `agentCardModel.ts` keeps the slider math (pure logic) but drops
  its own mode buttons/captions; the agent card renders the posture pill.
  `chatView.ts` keeps the host-side resolution (env > project > user).
- **Context:** one entry point — the statusline ctx button opens the Context
  Cockpit (inspector). The context page becomes a tab inside the cockpit,
  not a separate overlay. Token Budget bar lives in the cockpit, not in
  Settings → Agent.
- **Stats:** one renderer — `stats.ts` owns all stat formatting. chat.ts
  statusline, usage popover, and Settings all call it; no parallel formatters.
- **Badges:** `badge.ts` is the only badge. `mcpIcons.ts` drops its own
  `lettersOf` + `LOOKS` table and uses `badge()`.
- **Empty states:** one — `emptyState.ts`. Settings uses it too.
- **Save confirmation:** one idiom — `flashSaved` ("Saved ✓"). The
  add-provider form drops its separate `status` text.

## 7. Dead code to remove

- `browserCockpit.refreshCockpit` (no call sites)
- `settingsLayout.navHtml` (never called; scroll-spy only arms for chips the
  tabbed page never renders)
- Slash commands `fix` / `toggleBrowser` (posted, never handled — remove from
  `COMMANDS` or wire them; do not leave dead commands)
- The posture `experimental` flag gate: either apply it (hide the pill until
  experimental) or delete the flag — no stored-but-unused state
- `toolDiscoveryHtml` section id `sec-discovery` — add it to the `SectionId`
  union or drop the fold state for it
- Duplicate Kernel card styles (one definition, in tokens-adjacent CSS)
- Duplicate `.mp-custom-entry`, `.composer`, `.input-wrap` rules
- The "polish" appendices at the end of both CSS files — fold their rules
  into the components they tune, then delete the appendices

## 8. Message protocol — DO NOT BREAK

- `chatView.ts` `FORWARD` set (45 types) and the host-handled types are the
  contract. No type is added, removed, or renamed. No payload shape changes.
- `chat.ts` `Incoming` union: `contextItems` is dispatched via
  `inspector.onMessage` despite not being in the union — add it to the union
  while here (type-only fix, no behavior change).
- Panels keep their existing outbound message shapes.

## 9. Verification

- `npm run typecheck` (root + webview) — must pass
- `npm run lint` on changed files — must pass
- `npm run format:check` — must pass (run `prettier --write` on changed files)
- `cd vscode && node build.mjs` — must pass
- `npx vitest run --project unit --project integration --changed origin/main`
  (or the full suites if fast enough) — no regressions
- No new test suites. Add/adjust only tests covering changed behavior.

## 10. Work slices (parallel workers, separate clones)

| #   | Slice                    | Files                                                                                                                                                                                                                         | Notes                                                                                                                        |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Design system + CSS      | `media/tokens.css` (new), `media/chat.css`, `media/settings.css`, `chatView.ts` (CSS load order only)                                                                                                                         | Tokens first; dedupe kernel card, composer, mp-custom-entry; delete polish appendices; kill hardcoded brights                |
| 2   | Chat surface             | `webview/chat.ts`, `webview/render.ts`, `webview/emptyState.ts`, `webview/suggestBox.ts`, `webview/suggest.ts`                                                                                                                | Composer, message list, empty state, statusline, think accordions, tool clusters; remove dead slash commands; welcome dedupe |
| 3   | Settings + model + roles | `webview/settings.ts`, `settingsLayout.ts`, `modelPicker.ts`, `badge.ts`, `roles.ts`, `rankList.ts`, `agentCard.ts`, `agentCardModel.ts`, `posture.ts`, `domain.ts`, `providerForm.ts`, `stats.ts` (settings-side usage only) | Unify model picking, execution mode, stats; one save idiom; tab layout stays                                                 |
| 4   | Panels                   | `webview/stats.ts`, `crew.ts`, `mcp.ts`, `mcpCards.ts`, `mcpIcons.ts`, `inspector.ts`, `contextPage.ts`, `browserCockpit.ts`, `skills.ts`, `skillsList.ts`, `kernelObserve.ts`, `savedMark.ts`                                | One panel shape; context page → cockpit tab; badge unification; dead-code removal                                            |

File ownership is exclusive per slice except `stats.ts`, which slices 3 and 4
both touch — slice 3 owns its Settings usage, slice 4 owns the module itself;
coordinate through the coordinator, don't edit the same lines.

Each worker: own clone at `23a2a40`, branch `feat/ui-overhaul`, commit on its
slice branch, no push. Coordinator integrates.

## 11. Quiet Kernel + System-1 panels (2026-11-06, on top of the overhaul)

### Audit — what each row is for

**Kernel panel** (`vscode/src/webview/kernelObserve.ts`, painted by
`stats.updateKernel` into `#kernel-observe` / `#kernel-observe-settings`).
Data: `KernelSnapshot` from `src/runtime/kernel/observe.ts`
(`snapshotFromAllocateEvent`) built from the loop's `kernel.allocate` event
(`src/agent/loop.ts:597`). No protocol change: the snapshot type and the
state-frame shape are untouched; this is UI-only.

| Row                                             | Source                        | Verdict                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase pills (orient/plan/act/verify/synthesize) | `snapshot.phase`              | **Keep** — the only glanceable signal. Now the single quiet summary line instead of a full card.                                                                                                                                                             |
| Active capabilities (≤8, kind + id)             | `snapshot.active[].id`        | **Keep, names only.** The `why` text is raw bm25 ranking debug built in `src/runtime/kernel/kernel.ts:772` (`bm25 match for "<objective>" (reason)`); it is never rendered anymore. Truncation at the source was not needed — the UI simply drops the field. |
| Header meta (taskClass · tier · rank)           | snapshot fields               | **Trimmed.** `rank` is effectively always `bm25`; dropped. taskClass · tier survive in the summary line.                                                                                                                                                     |
| Cadence                                         | `snapshot.cadence` + `reason` | **Keep, inside the disclosure.** Changes per turn; a one-liner, not noise.                                                                                                                                                                                   |
| Selective mount ("X tok/turn saved")            | `snapshot.mountSavings`       | **Keep, conditional.** Hidden when the saving is 0 — with no catalog `mountSavings` is null and the row sat at "0 tok/turn saved" forever.                                                                                                                   |
| KV cache ("% hit · $ saved")                    | `Usage` totals                | **Removed.** It duplicated Live Stats (Cache Hit / Cache Saved, same data, same `Usage` object). The `Usage` parameter was dropped from `kernelObserveHtml` and `updateKernel` as a result.                                                                  |

**System-1 panel — does not exist at this base.** The strings "ask
clarification", "Guardrails … intercepted", "Patch sanity … caught", "Saved
0 tok · 0 turns", and "noise lines pruned" appear nowhere in `vscode/src/`
or `src/` (searched 2026-11-06). The closest analogues are not panels:
`src/telemetry/humanize.ts:305` renders a `context.pruned` event line
("pruned N superseded results …") and `src/telemetry/turn-trace.ts`
folds per-turn tool calls into a `/trace` line — neither is a UI panel and
neither renders in the webview. Nothing was removed because there is nothing
to remove; if those rows appear in a newer omnexx, they come from a state
shape this base does not have.

**Trace lines.** The per-turn trace (`turnTraceLine`,
`src/telemetry/humanize.ts:569`) folds `turn` / `tool.call` / gates only —
it never carries kernel allocate or bm25 text. `kernel.allocate` has no
formatter in `humanize.ts`, so it never appears as a chat-log line in the
webview either (at CLI debug verbosity it would surface via `debugLine`,
not in the panel). The bm25 `why` text only ever surfaced in the Kernel
card itself, which is now fixed. No trace-line change was needed.

### What changed

- `vscode/src/webview/kernelObserve.ts` — the card is now a `<details
class="ko">` collapsed by default: summary = "Kernel" + phase pills +
  taskClass · tier; body = capability names (kind + id, no `why`) + Cadence
  row + Selective mount row only when saving > 0. `Usage` param dropped.
- `vscode/src/webview/stats.ts` — `updateKernel(k)` drops the unused usage
  argument; `refresh()` updated to match.
- `vscode/src/webview/chat.ts` — `stats.updateKernel(next.kernel)` call
  updated to match.
- `vscode/media/chat.css` — `.ko-card` (border, background, entrance
  animation), `.ko-head`, `.ko-why`, `@keyframes ko-in` deleted. New
  `.ko` / `.ko-summary` disclosure styles reuse the existing `.chev`
  pattern and design tokens; detail rows indent under the summary.
- `test/unit/runtime/kernel-observe.test.ts` — render test updated to the
  disclosure (collapsed by default, no `why` text, no KV cache row) plus a
  new test for the hidden-when-zero mount row and the "core tools only"
  empty state.
- Nothing moved to the Output channel: the dropped `why` strings are
  ranking debug with no user-facing value, and the full `kernel.allocate`
  event payload is already emitted on the event stream for anyone who
  wants it (`src/agent/loop.ts:597`).

## 12. Control-board power (2026-11-06, on top of the overhaul)

The panel opens as a control board that isn't turned on: greyed out and
dormant. The omnexx logo is the power button — click it, move the mouse, or
click anywhere and the board brilliantly animates to life in full color.
The logo is also the kill switch: click it while on and the agent pauses.

### What changed

- `vscode/src/chatView.ts` — `<body>` ships `data-power="off"` (dormant on
  every fresh open; never persisted) and the statusline gains the power
  button first: `#power`, the logo image, `aria-pressed`.
- `vscode/media/tokens.css` — `--dur-wake: 600ms` motion token for the
  power-on sweep.
- `vscode/media/chat.css` — dormant rules desaturate + dim everything
  except `#power` (`grayscale(1) brightness(0.72)`); the lit button gets an
  accent halo, the dormant one a slow beacon pulse; `power-on` keyframes
  sweep color back in ~600ms with a glow flash; `prefers-reduced-motion`
  disables the pulse and collapses the sweep.
- `vscode/src/webview/chat.ts` — power state machine (`powerOn`,
  `applyPower`, `setPower`): dormant disables the composer input + send and
  guards `submit()`; the first `pointermove` or (capture-phase) click wakes
  the board, and the waking click is swallowed so nothing underneath fires.
  Kill switch: powering off posts the existing `pause` when a turn is
  running (the agent finishes its current step, then holds — no new turns);
  waking posts `resume` only when the last state frame said paused.
- No new message type was needed: `pause`/`resume` are already in the
  `FORWARD` set (`vscode/src/forward.ts`) and the chat server already
  handles them (`src/cli/chat-server.ts`, `session.command('pause' |
'resume')`); both are safe no-ops when nothing is running.
- `test/unit/vscode-chat-view-models.test.ts` — new `power` describe block
  asserts the rendered HTML ships `data-power="off"` with the `#power`
  button first in the statusline.
