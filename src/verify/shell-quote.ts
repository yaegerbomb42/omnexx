/**
 * Shell-quote a string for single-quoted POSIX sh context.
 * Encapsulates the string in single quotes and escapes any embedded single quotes
 * using the standard POSIX pattern: ' -> '\'' (close quote, escaped quote, open quote).
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
