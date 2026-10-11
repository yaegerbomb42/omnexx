declare module 'hoodiecrow-imap' {
  import type { Server } from 'node:net';

  interface HoodiecrowOptions {
    plugins?: string[];
    storage?: Record<string, unknown>;
    users?: Record<string, { password: string; xoauth2?: unknown }>;
  }
  export default function hoodiecrow(options?: HoodiecrowOptions): Server;
}
