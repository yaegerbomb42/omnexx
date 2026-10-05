import { z } from 'zod';
import { durationString } from '../duration.js';

export const SEARCH_BACKENDS = ['brave', 'tavily', 'searxng', 'exa'] as const;
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];

export const web = z
  .strictObject({
    fetch_enabled: z.boolean().default(false),
    allow: z.array(z.string()).default(['*']),
    deny: z.array(z.string()).default([]),
    fetch_timeout: durationString.default('15s'),
    max_fetch_bytes: z
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    search: z.enum(SEARCH_BACKENDS).optional(),
    search_key_env: z.string().optional(),
    search_url: z.url().optional(),
    search_timeout: durationString.default('15s'),
  })
  .prefault({});

export type WebConfig = z.infer<typeof web>;
