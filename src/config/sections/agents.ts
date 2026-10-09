import { z } from 'zod';

const remoteAgent = z.strictObject({
  /** The agent's A2A card URL, or its base URL (the card is read from /.well-known/agent-card.json). */
  url: z.url(),
  /** Headers to send, each an env var name, `secret:<KEY>`, or a literal (e.g. Authorization). */
  headers_env: z.record(z.string(), z.string()).default({}),
});

/**
 * [agents]: agent cards. Local ones are Markdown files (Claude Code's subagent format) read in
 * place; remote ones are A2A agents reached over HTTP.
 */
export const agents = z
  .strictObject({
    /** More folders of agent cards (`<dir>/<name>.md`); `~` is the home folder. */
    dirs: z.array(z.string().min(1)).default([]),
    /** Also use Claude Code's agents: `~/.claude/agents` and the repo's `.claude/agents`. */
    import_claude: z.boolean().default(true),
    /** Remote A2A agents by name. */
    remote: z.record(z.string(), remoteAgent).default({}),
  })
  .prefault({});
