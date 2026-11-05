/**
 * System-1 capability retrieval over very large catalogs (50k+ MCP Registry servers,
 * local MCP servers, skills, native tools).
 *
 * - Field-weighted BM25 (name / server id weigh more than free-text description)
 * - Inverted index: a query only touches postings of its own terms (~ms on 56k docs)
 * - Query expansion: domain synonyms (k8s→kubernetes, "pull request"→github, …)
 * - Priors: installed-first, exact-name match, official-publisher namespace match
 */

export interface RetrievalDoc {
  id: string;
  kind: 'tool' | 'skill' | 'mcp';
  name: string;
  description: string;
  server?: string | undefined;
  triggerConditions?: string | undefined;
}

const STOP = new Set(
  (
    'a an and are as at be by for from get give has have i in into is it its me my of on or our ' +
    'please show so that the their them then this to up us use using was we what when where ' +
    'which with you your all any can do does just make new now out over some via will would ' +
    'mcp server servers tool tools api apis app apps agent agents ai integration service'
  ).split(' '),
);

/** Light stemmer: enough to fold plurals / -ing / -ed for matching, not linguistics. */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed') && !t.endsWith('eed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us'))
    return t.slice(0, -1);
  return t;
}

export function tokenizeText(text: string): string[] {
  const out: string[] = [];
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/**
 * Domain synonyms used for query expansion. Keys/values are stemmed tokens; a phrase key
 * (with a space) matches adjacent query tokens.
 */
export const DEFAULT_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  k8s: ['kubernetes'],
  kubectl: ['kubernetes'],
  pod: ['kubernetes'],
  namespace: ['kubernetes'],
  helm: ['kubernetes'],
  'pull request': ['github'],
  pr: ['github'],
  repo: ['github', 'git'],
  repository: ['github', 'git'],
  postgresql: ['postgres'],
  psql: ['postgres'],
  mongo: ['mongodb'],
  e2e: ['playwright', 'browser'],
  'end end': ['playwright', 'browser'],
  'browser test': ['playwright'],
  headless: ['browser', 'playwright'],
  sms: ['twilio'],
  text: [],
  ticket: ['jira', 'linear'],
  crash: ['sentry'],
  exception: ['sentry'],
  'stack trace': ['sentry'],
  error: [],
  wiki: ['notion', 'confluence'],
  inbox: ['gmail', 'email'],
  email: ['gmail', 'mail'],
  mail: ['gmail', 'email'],
  meeting: ['calendar'],
  bucket: ['s3'],
  forecast: ['weather'],
  spreadsheet: ['xlsx', 'excel', 'sheet'],
  excel: ['xlsx'],
  word: ['docx'],
  changelog: ['release'],
  'release note': ['release', 'changelog'],
  paper: ['arxiv', 'scholar'],
  transcript: ['youtube'],
  video: ['youtube'],
  cache: ['redis'],
  dns: ['cloudflare'],
  cdn: ['cloudflare'],
  preview: ['vercel'],
  infrastructure: ['terraform'],
  vpc: ['terraform', 'aws'],
  dashboard: ['grafana'],
  monitor: ['datadog'],
  incident: ['pagerduty'],
  'on call': ['pagerduty'],
  deal: ['hubspot', 'crm'],
  crm: ['hubspot', 'salesforce'],
  opportunity: ['salesforce'],
  base: ['airtable'],
  card: ['trello'],
  task: [],
  store: ['shopify'],
  inventory: ['shopify'],
  vault: ['obsidian'],
  directions: ['maps'],
  route: ['maps'],
  translate: ['deepl', 'translation'],
  image: ['image', 'imagegen'],
  log: ['elasticsearch', 'logging'],
  file: ['filesystem'],
  directory: ['filesystem'],
  folder: ['filesystem'],
  url: ['fetch'],
  webpage: ['fetch', 'scrape'],
  'search web': ['search', 'brave'],
  'web search': ['search', 'brave'],
  slack: ['slack'],
  channel: ['slack', 'discord'],
  landing: ['frontend'],
  component: ['frontend', 'ui'],
};

interface Posting {
  doc: number;
  tf: number; // field-weighted term frequency
}

export interface RankOptions {
  /** Ids treated as installed (local MCP / skills / native tools). */
  isInstalled?: ((doc: RetrievalDoc) => boolean) | undefined;
  /** Extra (already-tokenizable) context: recent tool errors, state delta. Lower weight. */
  context?: string | undefined;
  /** Per-doc additive bonus (e.g. co-usage prior, stickiness). */
  bonus?: ((doc: RetrievalDoc) => number) | undefined;
  /** Optional dense scorer: cosine(query, doc) in [-1, 1] (hybrid retrieval). */
  dense?: ((doc: RetrievalDoc, index: number) => number) | undefined;
}

export interface Ranked {
  doc: RetrievalDoc;
  index: number;
  score: number;
}

/** Installed + named by the task: ranks above every uninstalled capability. */
export const INSTALLED_NAMED_TIER = 1000;
const NAME_W = 3;
const DESC_W = 1;
const K1 = 1.2;
const B = 0.6;

function serverTail(d: RetrievalDoc): string {
  return (d.server ?? d.name).split('/').pop() ?? d.name;
}

function serverNamespace(d: RetrievalDoc): string {
  const s = d.server ?? '';
  const i = s.indexOf('/');
  return i > 0 ? s.slice(0, i) : '';
}

export class CapabilityRetriever {
  private docs: RetrievalDoc[] = [];
  private postings = new Map<string, Posting[]>();
  private docLen: number[] = [];
  private avgLen = 1;
  private nameTokens: Set<string>[] = [];
  private nsTokens: Set<string>[] = [];
  private readonly synonyms: Readonly<Record<string, readonly string[]>>;

  constructor(synonyms: Readonly<Record<string, readonly string[]>> = DEFAULT_SYNONYMS) {
    const stemmed: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(synonyms)) {
      stemmed[tokenizeText(k).join(' ') || k] = v.map((x) => stem(x));
    }
    this.synonyms = stemmed;
  }

  get size(): number {
    return this.docs.length;
  }

  build(docs: readonly RetrievalDoc[]): void {
    this.docs = [...docs];
    this.postings.clear();
    this.docLen = [];
    this.nameTokens = [];
    this.nsTokens = [];
    let total = 0;
    for (let i = 0; i < this.docs.length; i++) {
      const d = this.docs[i] as RetrievalDoc;
      const nameToks = tokenizeText(`${d.name} ${serverTail(d)}`);
      const descToks = tokenizeText(`${d.description} ${d.triggerConditions ?? ''}`);
      this.nameTokens.push(new Set(nameToks));
      this.nsTokens.push(new Set(tokenizeText(serverNamespace(d))));
      const tf = new Map<string, number>();
      for (const t of new Set(nameToks)) tf.set(t, (tf.get(t) ?? 0) + NAME_W);
      for (const t of descToks) tf.set(t, (tf.get(t) ?? 0) + DESC_W);
      let len = 0;
      for (const [t, f] of tf) {
        len += f;
        let p = this.postings.get(t);
        if (!p) {
          p = [];
          this.postings.set(t, p);
        }
        p.push({ doc: i, tf: f });
      }
      this.docLen.push(len);
      total += len;
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
  }

  /** Query terms with weights: original 1.0, synonym expansions 0.6, context 0.35. */
  expandQuery(query: string, context?: string): Map<string, number> {
    const q = new Map<string, number>();
    const toks = tokenizeText(query);
    const add = (t: string, w: number) => q.set(t, Math.max(q.get(t) ?? 0, w));
    for (const t of toks) add(t, 1);
    for (let i = 0; i < toks.length; i++) {
      const uni = this.synonyms[toks[i] as string];
      if (uni) for (const s of uni) add(s, 0.6);
      if (i + 1 < toks.length) {
        const bi = this.synonyms[`${toks[i]} ${toks[i + 1]}`];
        if (bi) for (const s of bi) add(s, 0.8);
      }
    }
    if (context) for (const t of tokenizeText(context)) add(t, 0.35);
    return q;
  }

  rank(query: string, k = 10, opts: RankOptions = {}): Ranked[] {
    const terms = this.expandQuery(query, opts.context);
    const N = this.docs.length;
    const scores = new Map<number, number>();
    for (const [t, qw] of terms) {
      const plist = this.postings.get(t);
      if (!plist) continue;
      const idf = Math.log(1 + (N - plist.length + 0.5) / (plist.length + 0.5));
      for (const { doc, tf } of plist) {
        const norm = tf + K1 * (1 - B + (B * (this.docLen[doc] ?? 1)) / this.avgLen);
        const s = qw * idf * ((tf * (K1 + 1)) / norm);
        scores.set(doc, (scores.get(doc) ?? 0) + s);
      }
    }
    const primary = [...terms].filter(([, w]) => w >= 0.6).map(([t]) => t);
    const out: Ranked[] = [];
    for (const [i, base] of scores) {
      const d = this.docs[i] as RetrievalDoc;
      let score = base;
      const names = this.nameTokens[i] as Set<string>;
      // Exact name match: the capability IS the thing named (slack ↔ "slack" server).
      const nameHits = primary.filter((t) => names.has(t)).length;
      if (nameHits) {
        score *= 1 + 0.25 * nameHits;
        if (names.size <= 2 + nameHits) score *= 1.15; // focused name, not a 6-word mashup
      }
      // Official publisher: namespace carries the product name (io.github.getsentry/…).
      const ns = this.nsTokens[i] as Set<string>;
      if (
        primary.some(
          (t) => ns.has(t) || [...ns].some((n) => n.length > 4 && n.includes(t) && t.length > 3),
        )
      )
        score *= 1.2;
      // Installed-first: an installed capability that is named by the task beats any
      // uninstalled registry twin; an installed one that merely matches text gets a nudge.
      if (opts.isInstalled?.(d))
        score = nameHits && d.kind !== 'tool' ? score * 2 + INSTALLED_NAMED_TIER : score * 1.3 + 1;
      if (opts.bonus) score += opts.bonus(d);
      if (opts.dense) score += 3 * Math.max(0, opts.dense(d, i));
      out.push({ doc: d, index: i, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }
}
