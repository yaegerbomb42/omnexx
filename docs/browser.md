# Browser Tool & Verification Gate

The `browser` tool enables Omnexx to navigate, inspect, interact with, and verify web applications autonomously.

## Capabilities

- **Backends:**
  - `agent-browser`: Automatically used when the `agent-browser` CLI is present on `PATH`. Provides fast headless browser automation with accessibility trees and ref IDs (`@e1`, `@e2`, etc.).
  - `playwright-core`: Optional peer dependency (`npm install -D playwright-core`). Automatically loaded when `agent-browser` is not found.
  - If neither backend is available, the tool is not registered and `omnexx doctor` outputs an actionable hint.
- **Actions:**
  - `open(url)`: Navigates to a URL. Checks the URL against `[browser] allow`. Returns the accessibility tree snapshot immediately.
  - `snapshot()`: Produces an accessibility tree of the current page with ref IDs, trimmed to 4,000 tokens with a `…N more nodes` truncation notice when large.
  - `click(ref)`: Clicks an element by snapshot ref (e.g., `@e1` or `e1`) or CSS selector/id.
  - `type(ref, text)`: Types into an input after its current value; `fill(ref, text)` clears it first.
  - `press(key)`: Simulates keyboard key press (e.g. `Enter`, `Tab`).
  - `scroll(direction?, amount?)`: Scrolls the page (`up`, `down`, `left`, `right`).
  - `select(ref, value)`, `check(ref)`, `uncheck(ref)`, `hover(ref)`: form controls; `select` takes an option value or its visible label.
  - `upload(ref, path)`: Uploads a file; `path` must be inside the repo (same jail as file tools).
  - `wait_for(ref | text, timeout_ms?)`: Waits (default 10s) for an element or text to appear. `open`, `click` and `new_tab` also wait for the page to finish loading (best-effort, 5s).
  - `get_text(ref)`, `get_url()`: read an element's text or the current URL.
  - `eval(expression)`: Evaluates a JS expression in the page and returns its JSON. Off unless `[browser] allow_eval = true`: page scripts can change app state, submit forms, or read cookies and storage, so treat it as a write.
  - `network()`: Recent requests with status (failed ones show `FAILED`), to debug API calls.
  - `tabs()`, `switch_tab(tab)`, `new_tab(url)`, `close_tab(tab?)`: tabs, including ones opened by links (`target=_blank`), which become active.
  - `screenshot()`: Saves a PNG under the run's `logs/browser/` (never the repo) and returns its path, size and URL.
  - `console()`: Returns captured console logs and errors (last 50 entries).
  - `close()`: Closes the browser session.

Element actions given a stale snapshot ref retry once after a fresh snapshot; if the ref is still missing the error includes the current snapshot. Outputs are capped (snapshots 4,000 tokens, console/network 50 entries, text 4,000 chars). If the browser itself dies, the session is closed so no process is left behind. When a backend lacks an action the tool says so.

## Configuration

In `omnexx.toml`:

```toml
[browser]
enabled = true                  # default true when a backend exists
allow = ["localhost", "127.0.0.1", "*.local"] # allowed domain patterns
serve = "npm run dev"           # optional dev-server command
serve_port = 3000               # dev-server port to wait for
serve_timeout = "60s"           # timeout to wait for dev-server port
headless = true                 # headless browser execution
allow_eval = false              # let the eval action run page JavaScript
```

## Security & URL Allowlist

Only URLs whose host matches an entry in `browser.allow` (exact match or `*.pattern`) and use `http:` or `https:` protocols are permitted. Any disallowed URL is immediately refused and emits a `browser.denied` telemetry event.

## Browser Gates

Browser acceptance gates allow end-to-end verification of web interfaces using a simple DSL without extra dependencies.

In `omnexx.toml`:

```toml
[[gates]]
name = "e2e-ui"
kind = "browser"
script = "test/fixtures/browser-app/e2e/check.yaml"
level = "ratchet"
```

### Gate Script DSL (`.yaml` or `.toml`)

Supported step actions:

- `open`: navigates to URL
- `click`: clicks element by ref or selector
- `type`: enters text into selector
- `fill`: clears the field, then enters text
- `select`: chooses an option (`selector`, `value`)
- `wait_for`: waits for `selector` or `text` (optional `timeout_ms`, default 10000)
- `expect_url`: asserts the current URL contains `url` (`${URL}` is substituted)
- `wait_ms`: pauses for specified milliseconds
- `expect_text`: asserts text is present in the accessibility snapshot
- `expect_selector`: asserts selector or ref is present
- `expect_no_console_errors`: asserts that no `console.error` logs were triggered

The gate produces a standard `GateResult` with structured pass/fail counts and failures.

## Telemetry Events

The browser tool and gates emit the following events:

- `browser.open`: `{ url: string, backend: string }`
- `browser.action`: `{ action: string, ... }`
- `browser.denied`: `{ url: string, allow: string[], reason: string }`
- `browser.close`: `{ runId: string }`
