import type { z } from 'zod';
import { type ZodType } from 'zod';
import type { CompletionRequest, CompletionResponse, ContentBlock, Provider } from './types.js';

/** How a tool call was salvaged (for tests and telemetry). */
export type RepairKind = 'clean-parse' | 'fixed-json' | 'coerced-schema' | 're-asked';

export interface RepairedCall {
  name: string;
  input: unknown;
  repaired: boolean;
  kind: RepairKind | undefined;
}

/** Strip code fences, then fix trailing commas, single quotes and stringified JSON args. */
export function fixJsonText(raw: string): string {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m.exec(s);
  if (fence?.[1] !== undefined) s = fence[1].trim();
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"') && s.includes("'"))
  ) {
    // A whole payload wrapped in single quotes: unwrap one layer.
    if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  }
  // 'key': -> "key":  and  :'value' -> :"value" (careful: leaves apostrophes in words alone).
  s = s.replace(/'([^'\\\n]*?)'\s*:/g, '"$1":').replace(/:\s*'([^'\\\n]*?)'/g, ': "$1"');
  // Trailing commas before } or ].
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Parse tool arguments leniently: plain JSON, then fixed JSON, then {"...stringified"} unwrap. */
export function parseToolArgs(raw: unknown): { value: unknown; fixed: boolean } {
  if (typeof raw !== 'string') return { value: raw, fixed: false };
  const direct = tryParse(raw);
  if (direct.ok) {
    const v = direct.value;
    // Some weak models emit a JSON string containing JSON: unwrap one layer.
    if (typeof v === 'string') {
      const inner = tryParse(v);
      if (inner.ok) return { value: inner.value, fixed: true };
    }
    return { value: v, fixed: false };
  }
  const fixed = tryParse(fixJsonText(raw));
  if (fixed.ok) return { value: fixed.value, fixed: true };
  return { value: raw, fixed: false };
}

/** Coerce common mismatches toward the tool's zod schema: "42" -> 42, 1/0 -> bool, etc. */
export function coerceToSchema(value: unknown, schema: z.ZodType): unknown {
  if (schema.safeParse(value).success) return value;
  const def = (
    schema as unknown as {
      _def?: {
        type?: string;
        typeName?: string;
        innerType?: ZodType;
        options?: ZodType[];
        shape?: unknown;
      };
    }
  )._def;
  // Zod 4 stores the kind in `_def.type` ("number", "string", "object", ...);
  // older shapes used `typeName` ("ZodNumber", ...). Accept both.
  const rawKind = def?.type ?? def?.typeName ?? '';
  const typeName = rawKind.startsWith('Zod')
    ? rawKind
    : `Zod${rawKind.charAt(0).toUpperCase()}${rawKind.slice(1)}`;
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault') {
    if (value === undefined || value === null) return value;
    const inner = def?.innerType;
    if (inner) return coerceToSchema(value, inner);
    return value;
  }
  if (typeName === 'ZodNullable' && value === null) return value;
  if (typeName === 'ZodUnion' && Array.isArray(def?.options)) {
    for (const opt of def.options) {
      const coerced = coerceToSchema(value, opt);
      if (opt.safeParse(coerced).success) return coerced;
    }
    return value;
  }
  if (typeName === 'ZodNumber' && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    return value;
  }
  if (typeName === 'ZodBoolean' && typeof value === 'string') {
    const low = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(low)) return true;
    if (['false', 'no', '0'].includes(low)) return false;
    return value;
  }
  if (typeName === 'ZodString' && typeof value === 'number') return String(value);
  if (typeName === 'ZodArray' && !Array.isArray(value)) return [value];
  if (typeName === 'ZodObject') {
    const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
    if (typeof value === 'object' && value !== null && shape && typeof shape === 'object') {
      const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const [k, sub] of Object.entries(shape)) out[k] = coerceToSchema(out[k], sub);
      return out;
    }
  }
  return value;
}

/** Validate with a real zod schema (owned by the tool registry in the agent loop). */
export function validateWithSchema(
  input: unknown,
  schema: z.ZodType,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const coerced = coerceToSchema(input, schema);
  const parsed = schema.safeParse(coerced);
  if (parsed.success) return { ok: true, value: parsed.data };
  const msg = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: msg };
}

/** Repair one tool_use block: parse leniently; report whether it was fixed. */
export function repairToolCall(block: Extract<ContentBlock, { type: 'tool_use' }>): RepairedCall {
  const parsed = parseToolArgs(block.input);
  return {
    name: block.name,
    input: parsed.value,
    repaired: parsed.fixed,
    kind: parsed.fixed ? 'fixed-json' : 'clean-parse',
  };
}

/** One re-ask message carrying the validation error back to the model. */
export function reaskMessage(toolName: string, error: string, callId: string): string {
  return `The arguments for tool "${toolName}" (call ${callId}) were invalid: ${error}. Reply with a corrected "${toolName}" call using valid JSON arguments.`;
}

/**
 * Wrap a provider with tool-call repair: fix each tool_use's args in place. When a
 * call carries `_unparseable_arguments` (the Chat Completions adapter's marker),
 * treat the raw string as the repair input. Schema validation + the single re-ask
 * live in the agent loop (see INTEGRATION note); this wrapper only repairs syntax.
 */
export function withToolRepair(inner: Provider): Provider {
  return {
    get name(): string {
      return inner.name;
    },
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const res = await inner.complete(req);
      const content = res.content.map((b): ContentBlock => {
        if (b.type !== 'tool_use') return b;
        const raw =
          typeof b.input === 'object' &&
          b.input !== null &&
          '_unparseable_arguments' in b.input &&
          typeof (b.input as Record<string, unknown>)._unparseable_arguments === 'string'
            ? (b.input as Record<string, unknown>)._unparseable_arguments
            : b.input;
        const { value } = parseToolArgs(raw);
        return { ...b, input: value };
      });
      return { ...res, content };
    },
  };
}
