/** Create an element in `doc` with attributes and children (strings become text nodes). */
export function h(doc, tag, attrs = {}, children = []) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  return el;
}
