import type { SymbolQuery, SymbolResult } from './symbol-types.js';
import { MAX_REFS, MAX_TYPES, REF_CHARS } from './symbol-types.js';
import { askTsWorker, LS_PRELUDE } from './ts-worker.js';

/**
 * The worker answers read_symbol with the language service: navigate-to finds the definition,
 * go-to-definition resolves the types in its signature and the functions it calls, and
 * find-references lists its callers. Only definitions inside the repo count (no node_modules, no
 * lib .d.ts).
 */
const WORKER_SOURCE = `${LS_PRELUDE}
const MAX_REFS = ${String(MAX_REFS)};
const MAX_TYPES = ${String(MAX_TYPES)};
const REF_CHARS = ${String(REF_CHARS)};
const KINDS = new Set(['function', 'method', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var', 'getter', 'setter']);
const rel = (f) => f.slice(root.length + 1);
const local = (f) => f.startsWith(root + '/') && !f.includes('/node_modules/');
const program = () => ls.getProgram();
function nodeAt(sf, pos) {
  let found = sf;
  const visit = (n) => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n;
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}
const DECL_TESTS = [
  'isFunctionDeclaration', 'isMethodDeclaration', 'isClassDeclaration', 'isInterfaceDeclaration',
  'isTypeAliasDeclaration', 'isEnumDeclaration', 'isVariableStatement', 'isMethodSignature',
  'isPropertySignature', 'isPropertyDeclaration', 'isConstructorDeclaration', 'isGetAccessor',
  'isSetAccessor',
];
const DECL = (n) => DECL_TESTS.some((t) => ts[t](n));
function declAt(sf, pos) {
  let n = nodeAt(sf, pos);
  while (n && !DECL(n)) n = n.parent;
  return n;
}
function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line;
}
function block(sf, node) {
  const s = lineOf(sf, node.getStart(sf));
  const e = lineOf(sf, node.getEnd());
  return { file: rel(sf.fileName), start: s + 1, end: e + 1, lines: sf.text.split('\\n').slice(s, e + 1) };
}
function ref(sf, pos) {
  const l = lineOf(sf, pos);
  return { file: rel(sf.fileName), line: l + 1, text: sf.text.split('\\n')[l].trim().slice(0, REF_CHARS) };
}
function nameOf(decl) {
  if (ts.isVariableStatement(decl)) return decl.declarationList.declarations[0].name;
  return decl.name || decl;
}
function fnOf(decl) {
  if (!ts.isVariableStatement(decl)) return decl;
  const init = decl.declarationList.declarations[0].initializer;
  return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : decl;
}
function defsAt(file, pos) {
  return (ls.getDefinitionAtPosition(file, pos) || []).filter((d) => local(d.fileName));
}
function inPath(file, path) {
  return !path || rel(file) === path || rel(file).startsWith(path + '/');
}
function find(symbol, path) {
  return ls.getNavigateToItems(symbol, 200, undefined, true).filter((it) =>
    it.name === symbol && KINDS.has(it.kind) && local(it.fileName) && inPath(it.fileName, path));
}
function typeNames(node, out) {
  if (!node) return out;
  if (ts.isTypeReferenceNode(node)) out.push(node.typeName);
  if (ts.isExpressionWithTypeArguments(node)) out.push(node.expression);
  ts.forEachChild(node, (c) => { typeNames(c, out); });
  return out;
}
function signatureTypeNodes(decl, fn) {
  if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) return decl.heritageClauses || [];
  if (!fn.parameters) return [];
  return [...fn.parameters.map((p) => p.type), fn.type];
}
function defBlock(d) {
  const dsf = program().getSourceFile(d.fileName);
  const dd = dsf && declAt(dsf, d.textSpan.start);
  return dd ? { dsf, dd } : undefined;
}
function types(sf, decl, fn) {
  const out = new Map();
  for (const t of signatureTypeNodes(decl, fn)) {
    for (const name of typeNames(t, [])) {
      for (const d of defsAt(sf.fileName, name.getEnd() - 1)) {
        const hit = defBlock(d);
        if (!hit || hit.dd === decl) continue;
        out.set(d.fileName + ':' + hit.dd.getStart(hit.dsf), block(hit.dsf, hit.dd));
      }
    }
  }
  return [...out.values()].slice(0, MAX_TYPES);
}
function isImportish(n) {
  for (let p = n; p; p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  }
  return false;
}
function enclosing(n) {
  for (let p = n.parent; p; p = p.parent) {
    if (DECL(p) && !ts.isPropertySignature(p) && !(ts.isVariableStatement(p) && !ts.isSourceFile(p.parent))) return p;
  }
  return undefined;
}
function callers(sf, decl) {
  const out = new Map();
  for (const group of ls.findReferences(sf.fileName, nameOf(decl).getStart(sf)) || []) {
    for (const r of group.references) {
      if (r.isDefinition || !local(r.fileName)) continue;
      const rsf = program().getSourceFile(r.fileName);
      const n = rsf && nodeAt(rsf, r.textSpan.start);
      if (!n || isImportish(n)) continue;
      const enc = enclosing(n);
      const hit = ref(rsf, enc ? enc.getStart(rsf) : r.textSpan.start);
      out.set(hit.file + ':' + hit.line, hit);
    }
  }
  return [...out.values()];
}
function callees(sf, decl, fn) {
  const out = new Map();
  const visit = (n) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const e = n.expression;
      const target = ts.isPropertyAccessExpression(e) ? e.name : e;
      for (const d of defsAt(sf.fileName, target.getStart(sf))) {
        const hit = defBlock(d);
        if (!hit || hit.dd === decl) continue;
        const r = ref(hit.dsf, hit.dd.getStart(hit.dsf));
        out.set(r.file + ':' + r.line, r);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body || fn, visit);
  return [...out.values()];
}
function readSymbol(symbol, path, depth) {
  const decls = [];
  for (const it of find(symbol, path)) {
    const sf = program().getSourceFile(it.fileName);
    const decl = sf && declAt(sf, it.textSpan.start);
    if (decl && !decls.some((d) => d.decl === decl)) decls.push({ sf, decl });
  }
  if (!decls.length) return { kind: 'missing', suggestions: [] };
  if (decls.length > 1) {
    return { kind: 'ambiguous', candidates: decls.map(({ sf, decl }) => ref(sf, decl.getStart(sf))) };
  }
  const { sf, decl } = decls[0];
  const fn = fnOf(decl);
  const up = depth ? callers(sf, decl) : [];
  const down = depth ? callees(sf, decl, fn) : [];
  return {
    kind: 'found', engine: 'typescript', def: block(sf, decl), types: types(sf, decl, fn),
    callers: up.slice(0, MAX_REFS), callees: down.slice(0, MAX_REFS),
    callerTotal: up.length, calleeTotal: down.length,
  };
}
parentPort.on('message', ({ id, symbol, path, depth }) => {
  reply(id, () => readSymbol(symbol, path, depth));
});
`;

/** read_symbol through the repo's TypeScript language service, or null when unavailable. */
export function readSymbolTs(
  root: string,
  query: SymbolQuery,
  timeoutMs: number,
): Promise<SymbolResult | null> {
  return askTsWorker<SymbolResult>('symbol', WORKER_SOURCE, root, { ...query }, timeoutMs);
}
