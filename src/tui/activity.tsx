import { Text } from 'ink';

/** Ten-frame calm spinner; one 0.75 s cycle, the same cadence as the webview's CSS spinner. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** `▰▰▰▱▱` for done of total, `width` cells. */
export function progressBar(done: number, total: number, width = 10): string {
  const n = total ? Math.round((done / total) * width) : 0;
  return '▰'.repeat(n) + '▱'.repeat(width - n);
}

/** One frame of the shared activity spinner. */
export function ActivityIndicator({ frame }: { frame: number }) {
  return <Text>{SPINNER[frame % SPINNER.length]}</Text>;
}
