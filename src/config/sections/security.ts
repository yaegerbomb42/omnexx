import { z } from 'zod';

export const security = z
  .strictObject({
    /** Glob patterns of files allowed to contain matches that would otherwise trip the secret scanner. */
    secret_allow: z.array(z.string()).default([]),
  })
  .prefault({});

export type SecurityConfig = z.infer<typeof security>;
