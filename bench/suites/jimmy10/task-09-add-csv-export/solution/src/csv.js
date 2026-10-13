const field = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export function toCsv(rows, columns) {
  return [
    columns.map(field).join(','),
    ...rows.map((r) => columns.map((c) => field(r[c])).join(',')),
  ].join('\r\n');
}
