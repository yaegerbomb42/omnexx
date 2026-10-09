import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardTools } from '../../../src/agent/subagent.js';
import { listAgentCards, parseToolList } from '../../../src/instructions/agents.js';
import { fetchCard, replyText, sendMessage, toCard } from '../../../src/integrations/a2a.js';
import { writeServerSecrets } from '../../../src/integrations/secrets.js';
import { agentTool } from '../../../src/tools/extra/agent.js';
import type { HelperCard, Tool } from '../../../src/tools/types.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

const card = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${name} agent\n${extra}---\n\nYou are ${name}.\n`;

describe('agent cards', () => {
  it('reads Claude Code and omnexx cards in place, later folders win, empty bodies are skipped', async () => {
    const base = await tempDir('omnexx-cards-');
    const home = join(base, 'home');
    const repo = join(base, 'repo');
    const configHome = join(base, 'config');
    await mkdir(join(home, '.claude', 'agents'), { recursive: true });
    await mkdir(join(repo, '.omnexx', 'agents'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'agents', 'reviewer.md'),
      card('reviewer', 'tools: Read, Grep, Glob\n'),
    );
    await writeFile(join(home, '.claude', 'agents', 'arch.md'), card('arch'));
    await writeFile(join(repo, '.omnexx', 'agents', 'arch.md'), card('arch', 'tools: [Read]\n'));
    await writeFile(join(repo, '.omnexx', 'agents', 'empty.md'), '---\nname: empty\n---\n');
    const env = { HOME: home, OMNEXX_CONFIG_HOME: configHome };
    const cards = await listAgentCards({ repoRoot: repo, env, importClaude: true });
    expect(cards.map((c) => [c.name, c.source, c.tools])).toEqual([
      ['arch', 'repo', ['Read']],
      ['reviewer', 'claude-user', ['Read', 'Grep', 'Glob']],
    ]);
    expect(cards[1]?.prompt).toBe('You are reviewer.');
    expect(await listAgentCards({ repoRoot: repo, env, importClaude: false })).toHaveLength(1);
    expect(parseToolList(undefined)).toEqual([]);
  });

  it('maps a card’s Claude tool names onto the helper’s read-only tools', () => {
    const tools = ['read', 'outline', 'search', 'bash', 'read_log', 'web_fetch', 'recall'].map(
      (name) => ({ name }) as Tool,
    );
    const pick = (t: string[]) =>
      cardTools(tools, { name: 'x', prompt: '', tools: t }).map((x) => x.name);
    expect(pick(['Grep', 'Glob'])).toEqual(['read', 'search']);
    expect(pick(['Read', 'WebFetch'])).toEqual(['read', 'outline', 'web_fetch']);
    expect(pick(['Write', 'Edit'])).toEqual(['read']);
    expect(cardTools(tools, undefined)).toHaveLength(tools.length);
  });
});

/** A fake A2A server: serves a card and answers JSON-RPC, as v1.0 or only as v0.3. */
function a2aServer(version: '1.0' | '0.3') {
  const calls: {
    url: string;
    method?: string;
    body?: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  const fetchFn = ((url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (url.endsWith('/.well-known/agent-card.json'))
      return Promise.resolve(
        new Response(
          JSON.stringify(
            version === '1.0'
              ? {
                  name: 'Stock',
                  description: 'Stock checks',
                  supportedInterfaces: [
                    { url: 'https://a.example/rest', protocolBinding: 'HTTP+JSON' },
                    { url: '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
                  ],
                  skills: [{ id: 's1', name: 'Stock check' }],
                }
              : { name: 'Old', url: 'https://a.example/rpc', skills: [] },
          ),
        ),
      );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, method: String(body.method), body, headers });
    if (version === '0.3' && body.method === 'SendMessage')
      return Promise.resolve(new Response('{}', { status: 400 }));
    const result =
      version === '1.0'
        ? {
            task: {
              id: 't',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [{ parts: [{ text: '42 in stock' }] }],
            },
          }
        : { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'old answer' }] };
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('A2A client', () => {
  it('reads a v1.0 card and sends SendMessage with the version header', async () => {
    const { fetchFn, calls } = a2aServer('1.0');
    const c = await fetchCard('https://a.example', fetchFn);
    expect(c).toEqual({
      name: 'Stock',
      description: 'Stock checks',
      endpoint: 'https://a.example/rpc',
      skills: ['Stock check'],
    });
    expect(await sendMessage(c, 'how many?', { fetchFn })).toBe('42 in stock');
    expect(calls[0]?.method).toBe('SendMessage');
    expect(calls[0]?.headers.get('A2A-Version')).toBe('1.0');
    expect(JSON.stringify(calls[0]?.body)).toContain('"role":"ROLE_USER"');
  });

  it('falls back to v0.3 message/send when the server refuses v1.0', async () => {
    const { fetchFn, calls } = a2aServer('0.3');
    const c = await fetchCard('https://a.example/', fetchFn);
    expect(await sendMessage(c, 'old server?', { fetchFn })).toBe('old answer');
    expect(calls.map((x) => x.method)).toEqual(['SendMessage', 'message/send']);
    expect(JSON.stringify(calls[1]?.body)).toContain('"kind":"text"');
  });

  it('pulls text from messages, artifacts and status messages; rejects cards without an endpoint', () => {
    expect(replyText({ message: { parts: [{ text: 'a' }, { data: {} }] } })).toBe('a');
    expect(replyText({ task: { status: { message: { parts: [{ text: 'need input' }] } } } })).toBe(
      'need input',
    );
    expect(replyText(null)).toBe('');
    expect(() => toCard({ name: 'x' }, 'https://x/card.json')).toThrow(/no JSON-RPC endpoint/);
  });
});

describe('the agent tool', () => {
  it('runs a local card as a helper, with the card passed along', async () => {
    const seen: HelperCard[] = [];
    const ctx = await toolContext(await tempDir(), {
      subagent: (_d, _k, c) => {
        if (c) seen.push(c);
        return Promise.resolve('reviewed: fine');
      },
    });
    const local = [
      {
        name: 'reviewer',
        description: 'Reviews',
        prompt: 'Be strict.',
        tools: ['Read'],
        path: '',
        source: 'user' as const,
      },
    ];
    const tool = agentTool(local, {}, { env: {}, configHome: await tempDir() });
    expect(tool.description).toContain('- reviewer: Reviews');
    const r = await tool.run({ name: 'reviewer', message: 'review src/a.ts please' }, ctx);
    expect(r.content).toBe('reviewed: fine');
    expect(seen).toEqual([{ name: 'reviewer', prompt: 'Be strict.', tools: ['Read'] }]);
    const unknown = await tool.run({ name: 'nobody', message: 'anyone there at all?' }, ctx);
    expect(unknown.content).toMatch(/the agents are: reviewer/);
  });

  it('asks a remote agent with its stored secret header, and marks the reply untrusted', async () => {
    const { fetchFn, calls } = a2aServer('1.0');
    const configHome = await tempDir();
    await writeServerSecrets(configHome, 'agent:stock', { Authorization: 'Bearer s3' });
    const tool = agentTool(
      [],
      {
        stock: { url: 'https://a.example', headers_env: { Authorization: 'secret:Authorization' } },
      },
      { env: {}, configHome },
      fetchFn,
    );
    expect(tool.description).toContain('- stock (remote A2A agent)');
    const r = await tool.run(
      { name: 'stock', message: 'how many apples are there?' },
      await toolContext(await tempDir()),
    );
    expect(r.content).toMatch(/^Reply from the remote agent "stock" \(untrusted/);
    expect(r.content).toContain('42 in stock');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer s3');
  });
});

describe('omnexx agent-cards', () => {
  it('adds a remote agent with its header as a secret, lists it, and removes it', async () => {
    const { Command } = await import('commander');
    const { register } = await import('../../../src/cli/commands/agent-cards.js');
    const { readFile } = await import('node:fs/promises');
    const { readSecrets } = await import('../../../src/integrations/secrets.js');
    const base = await tempDir('omnexx-cards-cli-');
    const env = {
      PATH: process.env.PATH,
      HOME: join(base, 'home'),
      OMNEXX_CONFIG_HOME: join(base, 'config'),
      OMNEXX_HOME: join(base, 'state'),
    };
    await mkdir(env.OMNEXX_CONFIG_HOME, { recursive: true });
    await writeFile(join(env.OMNEXX_CONFIG_HOME, 'config.toml'), '# keep\n');
    const { fetchFn } = a2aServer('1.0');
    const run = async (args: string[]) => {
      let out = '';
      const program = new Command().exitOverride();
      register(
        program,
        {
          stdout: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WriteStream,
          stderr: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WriteStream,
          stdin: process.stdin,
          cwd: base,
          isTTY: false,
          env,
          fetch: fetchFn,
        },
        () => undefined,
      );
      await program.parseAsync(['node', 'omnexx', 'agent-cards', ...args]);
      return out;
    };
    expect(await run(['add', 'https://a.example', '--header', 'Authorization=Bearer t'])).toContain(
      'Added the remote agent "stock"',
    );
    const toml = await readFile(join(env.OMNEXX_CONFIG_HOME, 'config.toml'), 'utf8');
    expect(toml).toContain('# keep');
    expect(toml).toContain('[agents.remote.stock]');
    expect(toml).not.toContain('Bearer t');
    expect(await readSecrets(env.OMNEXX_CONFIG_HOME)).toEqual({
      'agent:stock': { Authorization: 'Bearer t' },
    });
    expect(await run(['list'])).toMatch(/stock\s+remote \(A2A\)\s+https:\/\/a\.example/);
    expect(await run(['remove', 'stock'])).toContain('Removed stock');
    expect(await readSecrets(env.OMNEXX_CONFIG_HOME)).toEqual({});
  });
});
