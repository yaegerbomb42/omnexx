import { z } from 'zod';
import { durationString } from '../duration.js';

export const browser = z
  .strictObject({
    enabled: z.boolean().default(false),
    allow: z.array(z.string()).default(['localhost', '127.0.0.1', '*.local']),
    serve: z.string().optional(),
    serve_port: z.number().int().positive().optional(),
    serve_timeout: durationString.default('60s'),
    headless: z.boolean().default(true),
    /** Lets the `eval` action run page JavaScript, which can change app state. */
    allow_eval: z.boolean().default(false),
    /**
     * After each action that can change the page, save a screenshot to the run's logs and emit
     * `browser.frame`, so an editor panel can show the agent's browser live. Never in the repo.
     */
    live_view: z.boolean().default(true),
    /**
     * Append new console errors, uncaught exceptions and failed requests (4xx/5xx or no response)
     * to the output of the action that caused them, and emit `browser.diagnostics`. This is what
     * lets the agent fix a frontend bug it just introduced without asking for a separate check.
     */
    report_errors: z.boolean().default(true),
    /** Percent of pixels (0-100) allowed to differ before a `visual_check` fails. */
    visual_diff_threshold: z.number().min(0).max(100).default(0.1),
    /**
     * Which browser: chromium (agent-browser or Playwright) or camoufox, an anti-detection Firefox
     * (Playwright + the optional camoufox-js package: `npm i -g camoufox-js && npx camoufox-js fetch`).
     */
    engine: z.enum(['chromium', 'camoufox']).default('chromium'),
    /**
     * Opt-in: a browser profile to reuse, with its logins and cookies. agent-browser takes a
     * Chrome profile name ("Default") or folder; Playwright and Camoufox take a folder they keep
     * their state in. The agent then acts as that profile on the sites browser.allow permits.
     */
    profile: z.string().min(1).optional(),
    /** Keep the agent's own cookies and storage under this name between runs (agent-browser). */
    session_name: z
      .string()
      .regex(/^[\w.-]{1,64}$/)
      .optional(),
  })
  .prefault({});

export type BrowserConfig = z.infer<typeof browser>;
