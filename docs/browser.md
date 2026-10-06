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
  - `type(ref, text)`: Fills/types into an input element.
  - `press(key)`: Simulates keyboard key press (e.g. `Enter`, `Tab`).
  - `scroll(direction?, amount?)`: Scrolls the page (`up`, `down`, `left`, `right`).
  - `screenshot()`: Captures a page screenshot. If the active model supports vision, returns the base64 image data block; otherwise returns an informative text note to avoid wasting tokens.
  - `console()`: Returns captured console logs and errors.
  - `close()`: Closes the browser session.

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
