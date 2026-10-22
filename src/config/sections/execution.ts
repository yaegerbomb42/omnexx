import { z } from 'zod';

/**
 * [execution]: one knob that picks a plan/loop preset (see src/config/execution.ts).
 * Presets fill in plan/loop keys the user did not set; explicit values anywhere win.
 * "normal" is today's defaults, byte-identical.
 */
export const execution = z
  .strictObject({
    mode: z.enum(['efficient', 'normal', 'extreme']).default('normal'),
  })
  .prefault({});

export type ExecutionConfig = z.infer<typeof execution>;
