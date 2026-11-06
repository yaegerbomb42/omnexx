import { describe, expect, it } from 'vitest';
import { CapabilityRetriever, stem, tokenizeText } from '../../../src/runtime/kernel/retrieval.js';
import { mergeLocalWithRegistry } from '../../../src/runtime/kernel/kernel.js';

const docs = [
  {
    id: 'registry:mcp:io.github.containers/kubernetes-mcp-server',
    kind: 'mcp' as const,
    name: 'kubernetes-mcp-server',
    description: 'Kubernetes and OpenShift cluster management',
    server: 'io.github.containers/kubernetes-mcp-server',
  },
  {
    id: 'registry:mcp:acme/slack-gif-party',
    kind: 'mcp' as const,
    name: 'slack-gif-party',
    description: 'Post party gifs, emojis, celebrations and fun reactions everywhere',
    server: 'acme/slack-gif-party',
  },
  {
    id: 'registry:mcp:com.slack/slack',
    kind: 'mcp' as const,
    name: 'slack',
    description: 'Official Slack workspace messages and channels',
    server: 'com.slack/slack',
  },
  {
    id: 'local:mcp:github',
    kind: 'mcp' as const,
    name: 'github',
    description: 'Locally configured MCP server "github". GitHub repos, issues and pull requests',
    server: 'github',
  },
  {
    id: 'registry:mcp:x/gh-pr-pull-request-review-github',
    kind: 'mcp' as const,
    name: 'gh-pr-pull-request-review-github',
    description: 'pull request review pull request github pr',
    server: 'x/gh-pr-pull-request-review-github',
  },
];

describe('CapabilityRetriever (field BM25 + expansion + priors)', () => {
  it('tokenizes camelCase / separators and stems plurals', () => {
    expect(tokenizeText('getPullRequests from io.github/foo-bar')).toEqual([
      'pull',
      'request',
      'io',
      'github',
      'foo',
      'bar',
    ]);
    expect(stem('issues')).toBe('issue');
  });

  it('expands k8s/pods to kubernetes', () => {
    const r = new CapabilityRetriever();
    r.build(docs);
    expect(r.rank('why do my pods crash loop in k8s', 1)[0]?.doc.id).toContain('kubernetes');
  });

  it('prefers the focused/official name over a keyword mashup', () => {
    const r = new CapabilityRetriever();
    r.build(docs);
    expect(r.rank('post a message to a slack channel', 1)[0]?.doc.id).toBe(
      'registry:mcp:com.slack/slack',
    );
  });

  it('ranks an installed capability named by the task first', () => {
    const r = new CapabilityRetriever();
    r.build(docs);
    const top = r.rank('open a pull request on GitHub', 2, {
      isInstalled: (d) => d.id.startsWith('local:'),
    });
    expect(top[0]?.doc.id).toBe('local:mcp:github');
  });

  it('enriches a local MCP entry with its registry twin text and drops the twin', () => {
    const merged = mergeLocalWithRegistry(
      [
        {
          id: 'local:mcp:sentry',
          kind: 'mcp',
          name: 'sentry',
          description: 'Locally configured MCP server "sentry"',
          server: 'sentry',
        },
      ],
      [
        {
          id: 'registry:mcp:io.github.getsentry/sentry-mcp',
          kind: 'mcp',
          name: 'sentry-mcp',
          description: 'Read Sentry issues and stack traces',
          server: 'io.github.getsentry/sentry-mcp',
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.description).toContain('stack traces');
  });
});
