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
  })
  .prefault({});

export type BrowserConfig = z.infer<typeof browser>;
