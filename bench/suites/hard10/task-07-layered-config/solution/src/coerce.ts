import type { Field } from './schema.ts';

export type Coerced = { ok: true; value: unknown } | { ok: false; message: string };

/** Turn an env/argv string into the field's type. */
export function coerce(field: Field, raw: string): Coerced {
  switch (field.type) {
    case 'integer':
      return /^-?\d+$/.test(raw.trim())
        ? { ok: true, value: Number(raw.trim()) }
        : { ok: false, message: `expected an integer, got "${raw}"` };
    case 'boolean': {
      const v = raw.trim().toLowerCase();
      if (v === 'true' || v === '1') return { ok: true, value: true };
      if (v === 'false' || v === '0') return { ok: true, value: false };
      return { ok: false, message: `expected a boolean, got "${raw}"` };
    }
    case 'string[]':
      return { ok: true, value: raw.split(',').map((s) => s.trim()).filter(Boolean) };
    default:
      return { ok: true, value: raw };
  }
}

/** Problems with an already-typed value, or null. */
export function validate(field: Field, value: unknown): string | null {
  switch (field.type) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'expected an integer';
      if (field.min !== undefined && value < field.min) return `must be >= ${String(field.min)}`;
      if (field.max !== undefined && value > field.max) return `must be <= ${String(field.max)}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected a boolean';
    case 'string':
      return typeof value === 'string' ? null : 'expected a string';
    case 'enum':
      return typeof value === 'string' && (field.values ?? []).includes(value)
        ? null
        : `expected one of ${(field.values ?? []).join(', ')}`;
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : 'expected an array of strings';
  }
}
