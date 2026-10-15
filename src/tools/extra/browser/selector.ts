/**
 * Semantic targets the model can use instead of a snapshot ref or CSS selector, which survive
 * re-renders: `text=Save`, `label=Email`, `placeholder=Search`, `role=button[name="Save"]`.
 */
export type SemanticTarget =
  | { by: 'text' | 'label' | 'placeholder'; value: string }
  | { by: 'role'; role: string; name?: string };

const SIMPLE = /^(text|label|placeholder)=(.+)$/s;
const ROLE = /^role=([a-z]+)(?:\[name=(["']?)(.*?)\2\])?$/is;

const unquote = (s: string): string => s.trim().replace(/^(["'])(.*)\1$/s, '$2');

/** The semantic target `ref` names, or null for a snapshot ref or CSS selector. */
export function parseSemantic(ref: string): SemanticTarget | null {
  const s = ref.trim();
  const simple = SIMPLE.exec(s);
  if (simple?.[1] && simple[2] !== undefined) {
    const value = unquote(simple[2]);
    if (!value) return null;
    return { by: simple[1] as 'text' | 'label' | 'placeholder', value };
  }
  const role = ROLE.exec(s);
  if (role?.[1]) {
    const name = role[3];
    return name ? { by: 'role', role: role[1].toLowerCase(), name } : { by: 'role', role: role[1] };
  }
  return null;
}

export const describeTarget = (t: SemanticTarget): string =>
  t.by === 'role' ? `${t.role}${t.name ? ` "${t.name}"` : ''}` : `${t.by} "${t.value}"`;
