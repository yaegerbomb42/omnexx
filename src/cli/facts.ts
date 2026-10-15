import { realpath } from 'node:fs/promises';
import { git } from '../git/git.js';
import { readFacts, rankFacts, renderFact, withStaleness, writeFacts } from '../core/facts.js';
import { resolvePaths } from '../core/paths.js';
import { EXIT } from './exit-codes.js';
import { println, type CliIO } from './io.js';

export interface FactsOptions {
  stale?: boolean;
  json?: boolean;
}

async function repoRootOf(cwd: string): Promise<string> {
  const top = (
    await git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  ).stdout.trim();
  return realpath(top || cwd);
}

/** `omnexx facts [--stale] [--json]` and `omnexx facts forget <id>`. */
export async function factsCommand(
  io: CliIO,
  action: string | undefined,
  id: string | undefined,
  opts: FactsOptions,
): Promise<number> {
  const paths = resolvePaths(io.env);
  const root = await repoRootOf(io.cwd);
  const facts = await withStaleness(await readFacts(paths, root), root);
  if (action === 'forget') {
    if (!id || !facts.some((f) => f.id === id)) {
      println(io.stderr, `no fact ${id ?? '(missing id)'}; see \`omnexx facts\``);
      return EXIT.error;
    }
    await writeFacts(
      paths,
      root,
      (await readFacts(paths, root)).filter((f) => f.id !== id),
    );
    println(io.stdout, `forgot ${id}`);
    return EXIT.ok;
  }
  if (action !== undefined) {
    println(
      io.stderr,
      `unknown action "${action}"; use \`omnexx facts\` or \`omnexx facts forget <id>\``,
    );
    return EXIT.error;
  }
  const shown = rankFacts(opts.stale ? facts.filter((f) => f.stale) : facts);
  if (opts.json) println(io.stdout, JSON.stringify(shown, null, 2));
  else if (!shown.length)
    println(io.stdout, opts.stale ? 'no unverified facts' : 'no verified facts yet');
  else for (const f of shown) println(io.stdout, renderFact(f));
  return EXIT.ok;
}
