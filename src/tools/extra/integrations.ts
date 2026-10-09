import { join } from 'node:path';
import { z } from 'zod';
import type { OmnexxConfig } from '../../config/schema.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import { listSkillsWithSource } from '../../instructions/skills.js';
import { addSkills, installRegistryServer, isGitUrl } from '../../integrations/install.js';
import { planInstall, searchRegistry, type RegistryHit } from '../../integrations/registry.js';
import { fail, ok, type Tool, type ToolContext } from '../types.js';
import type { ToolSource, ToolWhere } from './types.js';

const kind = z.enum(['mcp', 'skill']);

const searchSchema = z.strictObject({
  kind: kind.describe(
    '"mcp" searches the official MCP registry; "skill" lists skills available here',
  ),
  query: z.string().min(1).describe('What to look for, e.g. "playwright", "github", "postgres"'),
});

const installSchema = z.strictObject({
  kind,
  name: z
    .string()
    .min(1)
    .describe(
      'mcp: a name to look up in the registry ("playwright"). skill: a path or git URL holding SKILL.md folders',
    ),
  pick: z
    .string()
    .optional()
    .describe(
      'mcp: the exact registry name from integrations_search, e.g. io.github.microsoft/playwright-mcp',
    ),
  settings: z
    .record(z.string(), z.string())
    .optional()
    .describe('mcp: values the server needs (e.g. a token the person gave you), stored as secrets'),
});

/** Where installs write, from the run's or chat's own environment. */
interface Places {
  configFile: string;
  configHome: string;
  cacheFile: string;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}

function placesFor(where: ToolWhere | undefined): Places {
  const env = where?.env ?? process.env;
  const paths = resolvePaths(env);
  return {
    configFile: userConfigFile(paths),
    configHome: paths.configHome,
    cacheFile: join(paths.configHome, 'cache', 'mcp-registry.json'),
    repoRoot: where?.repoRoot ?? process.cwd(),
    env,
  };
}

const hitLine = (h: RegistryHit) => {
  const plan = planInstall(h);
  return `${h.trusted ? '✓' : ' '} ${h.name} [${plan?.via ?? 'cannot run'}] ${(h.title ?? h.description ?? '').replace(/\s+/g, ' ').slice(0, 100)}${plan?.needs.length ? ` (needs ${plan.needs.map((n) => n.key).join(', ')})` : ''}`;
};

export function integrationsSearchTool(
  places: Places,
  fetchFn: typeof fetch = fetch,
): Tool<typeof searchSchema> {
  return {
    name: 'integrations_search',
    description:
      'Find MCP servers (tools from other services: browsers, GitHub, databases…) in the official registry, or list the skills available here. ✓ marks a known publisher; prefer those. Then use integrations_install.',
    schema: searchSchema,
    readOnly: true,
    async run(input, ctx) {
      if (input.kind === 'skill') {
        const skills = await listSkillsWithSource({
          repoRoot: places.repoRoot,
          env: places.env,
          importClaude: true,
        });
        const q = input.query.toLowerCase();
        const hits = skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q));
        return ok(
          hits.length
            ? hits.map((s) => `${s.name} (${s.source}): ${s.description.slice(0, 120)}`).join('\n')
            : `No skill here matches "${input.query}". A skill can be added from a path or git URL with integrations_install.`,
        );
      }
      try {
        const hits = await searchRegistry(input.query, { fetchFn, cacheFile: places.cacheFile });
        ctx.events.emit('integration.search', {
          kind: input.kind,
          query: input.query,
          hits: hits.length,
        });
        return ok(
          hits.length
            ? hits.slice(0, 10).map(hitLine).join('\n')
            : `Nothing in the MCP registry matches "${input.query}".`,
        );
      } catch (err) {
        return fail(`MCP registry search failed: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * Who may say yes: the person in chat (yolo answers for them), or `policy.auto_approve` in an
 * unattended run. Without either, nothing is installed: the suggestion is recorded instead.
 */
async function approve(
  ctx: ToolContext,
  autoApprove: boolean,
  question: string,
  suggestion: Record<string, unknown>,
): Promise<'yes' | 'no' | 'unattended'> {
  if (ctx.ask) return (await ctx.ask(`${question} [y/N]`)) ? 'yes' : 'no';
  if (autoApprove) return 'yes';
  ctx.events.emit('integration.suggested', suggestion);
  return 'unattended';
}

export function integrationsInstallTool(
  places: Places,
  autoApprove: boolean,
  fetchFn: typeof fetch = fetch,
): Tool<typeof installSchema> {
  return {
    name: 'integrations_install',
    description:
      'Install an MCP server from the registry or add skills from a path or git URL. The person is asked first (in unattended runs it is only suggested). New MCP tools work from the next cycle or a new chat.',
    schema: installSchema,
    // It writes the user's config, so planners and read-only helpers never get it.
    readOnly: false,
    async run(input, ctx) {
      if (input.kind === 'skill') {
        const where = isGitUrl(input.name) ? input.name : join(places.repoRoot, input.name);
        const answer = await approve(
          ctx,
          autoApprove,
          `Add the skills from ${input.name} to your skills?`,
          {
            kind: 'skill',
            source: input.name,
          },
        );
        if (answer === 'no') return fail('The person said no. Do not install it.');
        if (answer === 'unattended')
          return ok(
            `Not installed (unattended run): suggested adding skills from ${input.name}; it will be in the report.`,
          );
        const r = await addSkills(where, join(places.configHome, 'skills'));
        if (!r.found) return fail(`No SKILL.md found in ${input.name}.`);
        ctx.events.emit('integration.installed', { kind: 'skill', names: r.added });
        return ok(
          `Added ${r.added.join(', ') || 'nothing new'}${r.skipped.length ? `; already had ${r.skipped.join(', ')}` : ''}. Load one with the skill tool.`,
        );
      }

      let hits: RegistryHit[];
      try {
        hits = await searchRegistry(input.pick ?? input.name, {
          fetchFn,
          cacheFile: places.cacheFile,
        });
      } catch (err) {
        return fail(`MCP registry search failed: ${(err as Error).message}`);
      }
      const hit = input.pick ? hits.find((h) => h.name === input.pick) : hits[0];
      const plan = hit && planInstall(hit);
      if (!hit || !plan)
        return fail(
          hit
            ? `${hit.name} has no package or endpoint omnexx can run.`
            : `Nothing called "${input.name}" in the MCP registry; try integrations_search.`,
        );
      const settings = input.settings ?? {};
      const missing = plan.needs.filter((n) => n.required && !settings[n.key]);
      if (missing.length)
        return fail(
          `${hit.name} needs ${missing.map((n) => `${n.key}${n.description ? ` (${n.description})` : ''}`).join(', ')}. Ask the person for it, or have them run: omnexx mcp add ${input.name} --pick ${hit.name}`,
        );
      const question = [
        `Install the MCP server ${hit.name}?`,
        `  publisher ${hit.publisher}${hit.trusted ? ' (known publisher)' : ' (NOT a known publisher)'}`,
        `  runs ${plan.runs}`,
      ].join('\n');
      const answer = await approve(ctx, autoApprove, question, {
        kind: 'mcp',
        server: hit.name,
        trusted: hit.trusted,
        runs: plan.runs,
      });
      if (answer === 'no') return fail('The person said no. Do not install it.');
      if (answer === 'unattended')
        return ok(
          `Not installed (unattended run): suggested ${hit.name}; it will be in the report.`,
        );
      const values = Object.fromEntries(
        Object.entries(settings).map(([k, v]) => [
          k,
          k.toLowerCase() === 'authorization' && !/\s/.test(v) ? `Bearer ${v}` : v,
        ]),
      );
      await installRegistryServer(places.configFile, places.configHome, plan, values);
      ctx.events.emit('integration.installed', { kind: 'mcp', server: hit.name, as: plan.name });
      return ok(
        `Installed ${hit.name} as "${plan.name}" (${plan.runs}). Its tools are available from the next cycle, or in a new chat.`,
      );
    },
  };
}

export const source: ToolSource = {
  load: (config: OmnexxConfig, where?: ToolWhere) => {
    const places = placesFor(where);
    return [
      integrationsSearchTool(places),
      integrationsInstallTool(places, config.policy.auto_approve),
    ];
  },
};
