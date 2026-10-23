import { z } from 'zod';

/**
 * [execution]: one knob that picks a plan/loop preset (see src/config/execution.ts).
 * Presets fill in plan/loop keys the user did not set; explicit values anywhere win.
 * "normal" is today's defaults, byte-identical.
 */
export const execution = z
  .strictObject({
    mode: z.enum(['efficient', 'normal', 'extreme']).default('normal'),
    /**
     * The work domain (src/config/work-mode.ts): "swe" is software engineering with the
     * full code toolset and test gates; "general" is artifact work (documents, data,
     * research) with code-only tools suppressed and checks instead of test suites.
     */
    domain: z.enum(['swe', 'general']).default('swe'),
  })
  .prefault({});

export type ExecutionConfig = z.infer<typeof execution>;
