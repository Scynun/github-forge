// GraphQL (v4) endpoint for the github-core-clone forge: POST /api/graphql.
//
// Minimal, document-driven implementation — NOT a general GraphQL server.
// It implements exactly the surface the make.fun suite exercises (see
// build-notes/graphql-contract.md): a tokenizer + recursive-descent parser
// for the operation/variable/argument/field/fragment subset, an AST executor
// that resolves fields through a per-type resolver table, Relay-style global
// ids (base64url of "Type:owner/repo[:number]"), offset cursors, batched
// operations, and __type/__schema introspection for the types the suite
// probes. Unknown fields resolve to partial data + an error (HTTP 200);
// a repository lookup miss is a nullable null, not an error.
//
// Auth is enforced by app.ts before this handler runs (ctx.authed); this
// module never re-checks it. No Date.now()/Math.random(): ids and cursors
// are deterministic functions of store state.
//
// Store-shape assumptions (store.ts is written by another module; see the
// task interface): Repo.issues / Repo.pulls are Map<number, X> or X[];
// Repo.refs is Map<string, string> keyed "refs/heads/<branch>" (a plain
// object with the same keys also works). Issue.comments is an array of
// {id: number, body: string, createdSeq: number}. The git-object helpers
// (getObject/parseCommit/listTreeRecursive/mergeBase/makeCommit/putObject)
// are called through a loose structural cast because their exact
// signatures live in store.ts; squash merge tries makeCommit first and
// falls back to building the commit object with putObject.

import { Store, VIEWER, type Repo, type Issue, type Pull } from './store.ts';

export interface ReqCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  authed: boolean;
  reqId: string;
}

export interface Resp {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string | object | null;
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode base64url; null when the input is not canonical base64url. */
function b64urlDecode(text: string): string | null {
  if (typeof text !== 'string' || text === '') return null;
  try {
    const decoded = Buffer.from(text, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== text) return null;
    return decoded;
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return b64urlEncode(`Repository:${repo.fullName}`);
}

function issueGid(repo: Repo, number: number): string {
  return b64urlEncode(`Issue:${repo.fullName}:${number}`);
}

function pullGid(repo: Repo, number: number): string {
  return b64urlEncode(`PullRequest:${repo.fullName}:${number}`);
}

interface DecodedGid {
  type: 'Repository' | 'Issue' | 'PullRequest';
  fullName: string;
  number?: number;
}

function decodeGid(id: unknown): DecodedGid | null {
  if (typeof id !== 'string') return null;
  const raw = b64urlDecode(id);
  if (raw === null) return null;
  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const type = parts[0];
  if (type !== 'Repository' && type !== 'Issue' && type !== 'PullRequest') return null;
  const fullName = parts[1];
  if (!fullName || !fullName.includes('/')) return null;
  if (type === 'Repository') {
    if (parts.length !== 2) return null;
    return { type, fullName };
  }
  if (parts.length !== 3) return null;
  const number = Number(parts[2]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { type, fullName, number };
}

function encodeCursor(offset: number): string {
  return b64urlEncode(`cursor:${offset}`);
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const raw = b64urlDecode(value);
  if (raw === null) return 0;
  const m = /^cursor:(\d+)$/.exec(raw);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function gqlState(issueState: string): string {
  return issueState === 'closed' ? 'CLOSED' : 'OPEN';
}

// ---------------------------------------------------------------------------
// Store access helpers (tolerant of Map-vs-array / Map-vs-object shapes)
// ---------------------------------------------------------------------------

function findRepoByFullName(store: Store, fullName: string): Repo | undefined {
  const slash = fullName.indexOf('/');
  if (slash <= 0) return undefined;
  const owner = fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);
  const direct = store.getRepo(owner, name);
  if (direct) return direct;
  for (const repo of store.repos.values()) {
    if (repo.fullName === fullName) return repo;
  }
  return undefined;
}

function findRepo(store: Store, owner: unknown, name: unknown): Repo | undefined {
  if (typeof owner !== 'string' || typeof name !== 'string') return undefined;
  return store.getRepo(owner, name);
}

function allIssues(repo: Repo): Issue[] {
  const c = (repo as unknown as { issues: unknown }).issues;
  if (c instanceof Map) return [...(c as Map<number, Issue>).values()];
  if (Array.isArray(c)) return [...(c as Issue[])];
  return [];
}

function findIssue(repo: Repo, number: number): Issue | undefined {
  const c = (repo as unknown as { issues: unknown }).issues;
  if (c instanceof Map) return (c as Map<number, Issue>).get(number);
  if (Array.isArray(c)) return (c as Issue[]).find((i) => i.number === number);
  return undefined;
}

function insertIssue(repo: Repo, issue: Issue): void {
  const c = (repo as unknown as { issues: unknown }).issues;
  if (c instanceof Map) {
    (c as Map<number, Issue>).set(issue.number, issue);
    return;
  }
  if (Array.isArray(c)) {
    (c as Issue[]).push(issue);
  }
}

function allPulls(repo: Repo): Pull[] {
  const c = (repo as unknown as { pulls: unknown }).pulls;
  if (c instanceof Map) return [...(c as Map<number, Pull>).values()];
  if (Array.isArray(c)) return [...(c as Pull[])];
  return [];
}

function findPull(repo: Repo, number: number): Pull | undefined {
  const c = (repo as unknown as { pulls: unknown }).pulls;
  if (c instanceof Map) return (c as Map<number, Pull>).get(number);
  if (Array.isArray(c)) return (c as Pull[]).find((p) => p.number === number);
  return undefined;
}

function insertPull(repo: Repo, pull: Pull): void {
  const c = (repo as unknown as { pulls: unknown }).pulls;
  if (c instanceof Map) {
    (c as Map<number, Pull>).set(pull.number, pull);
    return;
  }
  if (Array.isArray(c)) {
    (c as Pull[]).push(pull);
  }
}

function getRefSha(repo: Repo, branch: string): string | undefined {
  const refs = (repo as unknown as { refs: unknown }).refs;
  const key = `refs/heads/${branch}`;
  if (refs instanceof Map) {
    const v = (refs as Map<string, string>).get(key);
    if (typeof v === 'string') return v;
    const bare = (refs as Map<string, string>).get(branch);
    return typeof bare === 'string' ? bare : undefined;
  }
  if (refs && typeof refs === 'object') {
    const r = refs as Record<string, unknown>;
    if (typeof r[key] === 'string') return r[key] as string;
    if (typeof r[branch] === 'string') return r[branch] as string;
  }
  return undefined;
}

function setRefSha(repo: Repo, branch: string, sha: string): void {
  const refs = (repo as unknown as { refs: unknown }).refs;
  const key = `refs/heads/${branch}`;
  if (refs instanceof Map) {
    (refs as Map<string, string>).set(key, sha);
    return;
  }
  if (refs && typeof refs === 'object') {
    (refs as Record<string, unknown>)[key] = sha;
  }
}

// --- git objects, via a loose structural view of the store ---------------

interface LooseStore {
  getObject(repo: Repo, sha: string): unknown;
  parseCommit(data: unknown): unknown;
  listTreeRecursive(repo: Repo, treeSha: string): unknown;
  mergeBase(repo: Repo, a: string, b: string): unknown;
  makeCommit(repo: Repo, opts: unknown): unknown;
  putObject(repo: Repo, type: string, data: unknown): unknown;
}

function looseStore(store: Store): LooseStore {
  return store as unknown as LooseStore;
}

function objectData(store: Store, repo: Repo, sha: string): Buffer | null {
  let raw: unknown;
  try {
    raw = looseStore(store).getObject(repo, sha);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
  const obj = raw as { data?: unknown; content?: unknown };
  if (Buffer.isBuffer(obj.data)) return obj.data;
  if (typeof obj.data === 'string') return Buffer.from(obj.data, 'utf8');
  if (Buffer.isBuffer(obj.content)) return obj.content;
  if (typeof obj.content === 'string') return Buffer.from(obj.content, 'utf8');
  return null;
}

interface CommitInfoLike {
  tree: string;
  parents: string[];
}

function commitInfo(store: Store, repo: Repo, sha: string): CommitInfoLike | null {
  const data = objectData(store, repo, sha);
  if (data === null) return null;
  let parsed: unknown;
  try {
    parsed = looseStore(store).parseCommit(data);
  } catch {
    return null;
  }
  const p = parsed as { tree?: unknown; parents?: unknown };
  if (typeof p.tree !== 'string') return null;
  const parents = Array.isArray(p.parents)
    ? (p.parents as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return { tree: p.tree, parents };
}

function treeEntries(
  store: Store,
  repo: Repo,
  treeSha: string,
): Map<string, { mode: string; sha: string }> | null {
  let raw: unknown;
  try {
    raw = looseStore(store).listTreeRecursive(repo, treeSha);
  } catch {
    return null;
  }
  if (raw instanceof Map) return raw as Map<string, { mode: string; sha: string }>;
  return null;
}

/** Paths whose blob differs between base and head trees (added/modified/deleted). */
function changedPaths(store: Store, repo: Repo, baseSha: string, headSha: string): string[] {
  const head = commitInfo(store, repo, headSha);
  if (head === null) return [];
  const headTree = treeEntries(store, repo, head.tree);
  if (headTree === null) return [];
  const base = commitInfo(store, repo, baseSha);
  const baseTree = base === null ? null : treeEntries(store, repo, base.tree);
  const paths = new Set<string>();
  for (const [path, entry] of headTree) {
    const b = baseTree?.get(path);
    if (!b || b.sha !== entry.sha) paths.add(path);
  }
  if (baseTree) {
    for (const path of baseTree.keys()) {
      if (!headTree.has(path)) paths.add(path);
    }
  }
  return [...paths].sort();
}

/**
 * Squash-merge a pull request: new commit whose tree is the head tree and
 * whose only parent is the base tip, then move the base branch ref to it.
 * Returns the merge commit sha, or an error message when it cannot merge
 * (missing objects, or a genuine content conflict between the two sides
 * since their merge-base).
 */
function squashMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
): { ok: true; sha: string } | { ok: false; error: string } {
  const headSha = pull.headSha;
  // Merge into the CURRENT base-branch tip, not the baseSha recorded when
  // the PR was opened: another PR may have moved the branch since then,
  // and that is exactly what makes the second merge conflict.
  const baseSha = getRefSha(repo, pull.baseRef) ?? pull.baseSha;
  if (typeof headSha !== 'string' || headSha === '' || typeof baseSha !== 'string' || baseSha === '') {
    return { ok: false, error: 'Pull request head or base commit is missing.' };
  }
  if (headSha === baseSha) return { ok: true, sha: baseSha };
  const head = commitInfo(store, repo, headSha);
  if (head === null) return { ok: false, error: 'Head commit not found.' };

  // Conflict check: only needed when the base has moved past the merge-base.
  let mergeBaseSha: string | null = null;
  try {
    const mb = looseStore(store).mergeBase(repo, baseSha, headSha);
    mergeBaseSha = typeof mb === 'string' ? mb : null;
  } catch {
    mergeBaseSha = null;
  }
  if (mergeBaseSha !== null && mergeBaseSha !== baseSha) {
    const base = commitInfo(store, repo, baseSha);
    const mbCommit = commitInfo(store, repo, mergeBaseSha);
    if (base !== null && mbCommit !== null) {
      const baseTree = treeEntries(store, repo, base.tree);
      const mbTree = treeEntries(store, repo, mbCommit.tree);
      const headTree = treeEntries(store, repo, head.tree);
      if (baseTree !== null && mbTree !== null && headTree !== null) {
        for (const [path, h] of headTree) {
          const m = mbTree.get(path);
          const b = baseTree.get(path);
          const headChanged = !m || m.sha !== h.sha;
          const baseChanged = b ? !m || m.sha !== b.sha : m !== undefined;
          if (headChanged && baseChanged && (!b || b.sha !== h.sha)) {
            return { ok: false, error: `Merge conflict: ${path} changed on both sides.` };
          }
        }
        for (const [path, m] of mbTree) {
          if (!headTree.has(path)) {
            const b = baseTree.get(path);
            if (b && b.sha !== m.sha) {
              return { ok: false, error: `Merge conflict: ${path} changed on both sides.` };
            }
          }
        }
      }
    }
  }

  const seq = store.tick();
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const epoch = store.epochSecFor(seq);
  const who = `${VIEWER.login} <${VIEWER.login}@users.noreply.github.com> ${epoch} +0000`;
  let sha: string | null = null;
  try {
    // Real store signature: makeCommit(repo, {tree, parents, author, committer, message})
    // where author/committer are full ident strings.
    const made = looseStore(store).makeCommit(repo, {
      tree: head.tree,
      parents: [baseSha],
      author: who,
      committer: who,
      message,
    });
    if (typeof made === 'string' && made !== '') sha = made;
  } catch {
    sha = null;
  }
  if (sha === null) {
    // Fallback: build the commit object directly (standard git format).
    try {
      const body = `tree ${head.tree}\nparent ${baseSha}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`;
      const made = looseStore(store).putObject(repo, 'commit', Buffer.from(body, 'utf8'));
      if (typeof made === 'string' && made !== '') sha = made;
    } catch {
      sha = null;
    }
  }
  if (sha === null) return { ok: false, error: 'Failed to create merge commit.' };
  setRefSha(repo, pull.baseRef, sha);
  return { ok: true, sha };
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface TypeNode {
  kind: 'named' | 'list' | 'nonNull';
  name?: string;
  ofType?: TypeNode;
}

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  arguments: ArgumentNode[];
}

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  arguments: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDefinitionNode {
  name: string;
  type: TypeNode;
  defaultValue?: ValueNode;
}

interface OperationDefinitionNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinitionNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

interface FragmentDefinitionNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  definitions: Array<OperationDefinitionNode | FragmentDefinitionNode>;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      // Block string: read until closing """.
      let j = i + 3;
      let value = '';
      let closed = false;
      while (j < n) {
        if (src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"') {
          closed = true;
          j += 3;
          break;
        }
        value += src[j];
        j += 1;
      }
      if (!closed) throw new Error('Syntax Error: Unterminated block string.');
      tokens.push({ kind: 'string', value });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === '"') {
          closed = true;
          j += 1;
          break;
        }
        if (c === '\n' || c === '\r') throw new Error('Syntax Error: Unterminated string.');
        if (c === '\\') {
          const esc = src[j + 1];
          if (esc === undefined) throw new Error('Syntax Error: Unterminated string.');
          if (esc === 'u') {
            const hex = src.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Syntax Error: Invalid unicode escape.');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else {
            const map: Record<string, string> = {
              '"': '"',
              '\\': '\\',
              '/': '/',
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
            };
            if (!(esc in map)) throw new Error(`Syntax Error: Invalid escape sequence "\\${esc}".`);
            value += map[esc];
            j += 2;
          }
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new Error('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'string', value });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k += 1;
        if (/[0-9]/.test(src[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < n && /[0-9]/.test(src[j])) j += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Syntax Error: Unexpected character "${ch}".`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent over the token list)
// ---------------------------------------------------------------------------

function parseDocument(src: string): DocumentNode {
  const tokens = tokenize(src);
  let pos = 0;

  function peek(): Token {
    return tokens[pos];
  }

  function next(): Token {
    return tokens[pos++];
  }

  function expectPunct(value: string): void {
    const t = next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new Error(`Syntax Error: Expected "${value}" but got "${t.value}".`);
    }
  }

  function expectName(what = 'a name'): string {
    const t = next();
    if (t.kind !== 'name') throw new Error(`Syntax Error: Expected ${what} but got "${t.value}".`);
    return t.value;
  }

  function parseValue(): ValueNode {
    const t = next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: expectName('a variable name') };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(peek().kind === 'punct' && peek().value === ']')) {
        if (peek().kind === 'eof') throw new Error('Syntax Error: Unterminated list.');
        values.push(parseValue());
      }
      next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(peek().kind === 'punct' && peek().value === '}')) {
        if (peek().kind === 'eof') throw new Error('Syntax Error: Unterminated object.');
        const name = expectName('an object field name');
        expectPunct(':');
        fields.push({ name, value: parseValue() });
      }
      next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Syntax Error: Unexpected token "${t.value}".`);
  }

  function parseType(): TypeNode {
    let type: TypeNode;
    if (peek().kind === 'punct' && peek().value === '[') {
      next();
      const inner = parseType();
      expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: expectName('a type name') };
    }
    if (peek().kind === 'punct' && peek().value === '!') {
      next();
      type = { kind: 'nonNull', ofType: type };
    }
    return type;
  }

  function parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (peek().kind === 'punct' && peek().value === '(') {
      next();
      while (!(peek().kind === 'punct' && peek().value === ')')) {
        if (peek().kind === 'eof') throw new Error('Syntax Error: Unterminated argument list.');
        const name = expectName('an argument name');
        expectPunct(':');
        args.push({ name, value: parseValue() });
      }
      next();
    }
    return args;
  }

  function parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (peek().kind === 'punct' && peek().value === '@') {
      next();
      directives.push({ name: expectName('a directive name'), arguments: parseArguments() });
    }
    return directives;
  }

  function parseVariableDefinitions(): VariableDefinitionNode[] {
    const defs: VariableDefinitionNode[] = [];
    if (peek().kind === 'punct' && peek().value === '(') {
      next();
      while (!(peek().kind === 'punct' && peek().value === ')')) {
        if (peek().kind === 'eof') throw new Error('Syntax Error: Unterminated variable definitions.');
        expectPunct('$');
        const name = expectName('a variable name');
        expectPunct(':');
        const type = parseType();
        let defaultValue: ValueNode | undefined;
        if (peek().kind === 'punct' && peek().value === '=') {
          next();
          defaultValue = parseValue();
        }
        defs.push({ name, type, defaultValue });
      }
      next();
    }
    return defs;
  }

  function parseSelectionSet(): SelectionNode[] {
    expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(peek().kind === 'punct' && peek().value === '}')) {
      if (peek().kind === 'eof') throw new Error('Syntax Error: Unterminated selection set.');
      selections.push(parseSelection());
    }
    next();
    return selections;
  }

  function parseSelection(): SelectionNode {
    if (peek().kind === 'spread') {
      next();
      if (peek().kind === 'name' && peek().value !== 'on') {
        const name = next().value;
        return { kind: 'spread', name, directives: parseDirectives() };
      }
      let typeCondition: string | undefined;
      if (peek().kind === 'name' && peek().value === 'on') {
        next();
        typeCondition = expectName('a type condition');
      }
      const directives = parseDirectives();
      return { kind: 'inline', typeCondition, directives, selectionSet: parseSelectionSet() };
    }
    const first = expectName('a field name');
    let alias: string | undefined;
    let name = first;
    if (peek().kind === 'punct' && peek().value === ':') {
      next();
      alias = first;
      name = expectName('a field name');
    }
    const args = parseArguments();
    const directives = parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (peek().kind === 'punct' && peek().value === '{') {
      selectionSet = parseSelectionSet();
    }
    return { kind: 'field', alias, name, arguments: args, directives, selectionSet };
  }

  function parseDefinition(): OperationDefinitionNode | FragmentDefinitionNode {
    const t = peek();
    if (t.kind === 'punct' && t.value === '{') {
      return {
        kind: 'operation',
        operation: 'query',
        variableDefinitions: [],
        directives: [],
        selectionSet: parseSelectionSet(),
      };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const operation = next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (peek().kind === 'name') name = next().value;
      const variableDefinitions = parseVariableDefinitions();
      const directives = parseDirectives();
      if (!(peek().kind === 'punct' && peek().value === '{')) {
        throw new Error(`Syntax Error: Expected selection set for ${operation} "${name ?? ''}".`);
      }
      return { kind: 'operation', operation, name, variableDefinitions, directives, selectionSet: parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      next();
      const name = expectName('a fragment name');
      const on = expectName('the keyword "on"');
      if (on !== 'on') throw new Error('Syntax Error: Expected "on" in fragment definition.');
      const typeCondition = expectName('a type condition');
      const directives = parseDirectives();
      return { kind: 'fragment', name, typeCondition, directives, selectionSet: parseSelectionSet() };
    }
    throw new Error(`Syntax Error: Unexpected token "${t.value}".`);
  }

  const definitions: Array<OperationDefinitionNode | FragmentDefinitionNode> = [];
  while (peek().kind !== 'eof') {
    definitions.push(parseDefinition());
  }
  if (definitions.length === 0) throw new Error('Syntax Error: Empty document.');
  return { definitions };
}

// ---------------------------------------------------------------------------
// Value evaluation
// ---------------------------------------------------------------------------

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
      return node.value;
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function evalArgs(args: ArgumentNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = evalValue(a.value, variables);
  return out;
}

function isSkipped(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const d of directives) {
    const args = evalArgs(d.arguments, variables);
    if (d.name === 'skip' && args.if === true) return true;
    if (d.name === 'include' && args.if === false) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Introspection type table (only the types the suite probes, plus the enums
// named in the contract header)
// ---------------------------------------------------------------------------

interface TypeRef {
  kind: string;
  name?: string;
  ofType?: TypeRef;
}

interface TypeInfo {
  name: string;
  kind: string;
  fields?: Array<{ name: string; type: TypeRef }>;
  enumValues?: string[];
}

const SCALAR = (name: string): TypeRef => ({ kind: 'SCALAR', name });
const ENUMT = (name: string): TypeRef => ({ kind: 'ENUM', name });
const OBJT = (name: string): TypeRef => ({ kind: 'OBJECT', name });
const NN = (t: TypeRef): TypeRef => ({ kind: 'NON_NULL', ofType: t });
const LIST = (t: TypeRef): TypeRef => ({ kind: 'LIST', ofType: t });

const TYPE_INFO: Record<string, TypeInfo> = {
  Query: {
    name: 'Query',
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: OBJT('User') },
      { name: 'repository', type: OBJT('Repository') },
      { name: 'node', type: OBJT('Node') },
      { name: '__type', type: OBJT('__Type') },
      { name: '__schema', type: OBJT('__Schema') },
    ],
  },
  Mutation: {
    name: 'Mutation',
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: OBJT('CreateIssuePayload') },
      { name: 'closeIssue', type: OBJT('CloseIssuePayload') },
      { name: 'createPullRequest', type: OBJT('CreatePullRequestPayload') },
      { name: 'mergePullRequest', type: OBJT('MergePullRequestPayload') },
      { name: 'addComment', type: OBJT('AddCommentPayload') },
    ],
  },
  User: {
    name: 'User',
    kind: 'OBJECT',
    fields: [{ name: 'login', type: NN(SCALAR('String')) }],
  },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: NN(SCALAR('ID')) },
      { name: 'databaseId', type: NN(SCALAR('Int')) },
      { name: 'name', type: NN(SCALAR('String')) },
      { name: 'nameWithOwner', type: NN(SCALAR('String')) },
      { name: 'owner', type: OBJT('User') },
      { name: 'defaultBranchRef', type: OBJT('Ref') },
      { name: 'viewerPermission', type: ENUMT('RepositoryPermission') },
      { name: 'hasIssuesEnabled', type: SCALAR('Boolean') },
      { name: 'issue', type: OBJT('Issue') },
      { name: 'issues', type: OBJT('IssueConnection') },
      { name: 'pullRequests', type: OBJT('PullRequestConnection') },
      { name: 'pullRequest', type: OBJT('PullRequest') },
      { name: 'description', type: SCALAR('String') },
    ],
  },
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: NN(SCALAR('ID')) },
      { name: 'number', type: NN(SCALAR('Int')) },
      { name: 'title', type: SCALAR('String') },
      { name: 'state', type: NN(ENUMT('IssueState')) },
      { name: 'body', type: SCALAR('String') },
      { name: 'createdAt', type: SCALAR('DateTime') },
    ],
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: NN(SCALAR('ID')) },
      { name: 'number', type: NN(SCALAR('Int')) },
      { name: 'title', type: SCALAR('String') },
      { name: 'body', type: SCALAR('String') },
      { name: 'state', type: NN(ENUMT('PullRequestState')) },
      { name: 'headRefName', type: SCALAR('String') },
      { name: 'baseRefName', type: SCALAR('String') },
      { name: 'mergeable', type: ENUMT('MergeableState') },
      { name: 'merged', type: SCALAR('Boolean') },
      { name: 'files', type: OBJT('PullRequestChangedFileConnection') },
      { name: 'createdAt', type: SCALAR('DateTime') },
    ],
  },
  SearchType: {
    name: 'SearchType',
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  },
  IssueState: { name: 'IssueState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  MergeableState: {
    name: 'MergeableState',
    kind: 'ENUM',
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
  PullRequestState: {
    name: 'PullRequestState',
    kind: 'ENUM',
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  PullRequestMergeMethod: {
    name: 'PullRequestMergeMethod',
    kind: 'ENUM',
    enumValues: ['MERGE', 'SQUASH', 'REBASE'],
  },
  RepositoryPermission: {
    name: 'RepositoryPermission',
    kind: 'ENUM',
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
  OrderDirection: { name: 'OrderDirection', kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: {
    name: 'IssueOrderField',
    kind: 'ENUM',
    enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecState {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDefinitionNode>;
}

interface Wrapped {
  __typename: string;
  data: unknown;
}

function w(typename: string, data: unknown): Wrapped {
  return { __typename: typename, data };
}

function isWrapped(value: unknown): value is Wrapped {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__typename' in value &&
    'data' in value &&
    typeof (value as { __typename: unknown }).__typename === 'string'
  );
}

type Resolver = (data: unknown, args: Record<string, unknown>, state: ExecState) => unknown;

function sortIssues(items: Issue[], orderBy: unknown): Issue[] {
  let direction = 'DESC';
  if (orderBy && typeof orderBy === 'object') {
    const o = orderBy as Record<string, unknown>;
    if (o.direction === 'ASC' || o.direction === 'DESC') direction = o.direction;
  }
  const mul = direction === 'ASC' ? 1 : -1;
  return [...items].sort(
    (a, b) => (a.createdSeq - b.createdSeq) * mul || (a.number - b.number) * mul,
  );
}

function paginate<T>(items: T[], args: Record<string, unknown>): { page: T[]; offset: number; hasNextPage: boolean; endCursor: string | null } {
  const total = items.length;
  const offset = decodeCursor(args.after);
  const first = typeof args.first === 'number' ? args.first : null;
  const page =
    first === null ? items.slice(offset) : items.slice(offset, offset + Math.max(0, first));
  const endOffset = offset + page.length;
  return {
    page,
    offset,
    hasNextPage: endOffset < total,
    endCursor: page.length > 0 ? encodeCursor(endOffset) : null,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
  let items = allIssues(repo);
  if (Array.isArray(args.states) && args.states.length > 0) {
    const want = new Set(args.states.map((s) => String(s).toLowerCase()));
    items = items.filter((i) => want.has(i.state));
  }
  items = sortIssues(items, args.orderBy);
  const total = items.length;
  const { page, offset, hasNextPage, endCursor } = paginate(items, args);
  return w('IssueConnection', {
    repo,
    items: page,
    offset,
    totalCount: total,
    pageInfo: { hasNextPage, endCursor },
  });
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
  const items = [...allPulls(repo)].sort(
    (a, b) => (a.createdSeq - b.createdSeq) * -1 || (a.number - b.number) * -1,
  );
  const total = items.length;
  const { page, offset, hasNextPage, endCursor } = paginate(items, args);
  return w('PullRequestConnection', {
    repo,
    items: page,
    offset,
    totalCount: total,
    pageInfo: { hasNextPage, endCursor },
  });
}

function filesConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, unknown>): Wrapped {
  const baseSha = typeof pull.baseSha === 'string' ? pull.baseSha : '';
  const headSha = typeof pull.headSha === 'string' ? pull.headSha : '';
  const paths = baseSha !== '' && headSha !== '' ? changedPaths(store, repo, baseSha, headSha) : [];
  const total = paths.length;
  const { page, offset, hasNextPage, endCursor } = paginate(paths, args);
  return w('PullRequestChangedFileConnection', {
    items: page,
    offset,
    totalCount: total,
    pageInfo: { hasNextPage, endCursor },
  });
}

function decodeSubjectId(
  store: Store,
  id: unknown,
): { repo: Repo; type: 'Issue' | 'PullRequest'; number: number } | null {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.number === undefined) return null;
  const repo = findRepoByFullName(store, decoded.fullName);
  if (!repo) return null;
  if (decoded.type === 'Repository') return null;
  return { repo, type: decoded.type, number: decoded.number };
}

function resolveNodeValue(store: Store, id: unknown): Wrapped | null {
  const decoded = decodeGid(id);
  if (decoded === null) return null;
  const repo = findRepoByFullName(store, decoded.fullName);
  if (!repo) return null;
  if (decoded.type === 'Repository') return w('Repository', repo);
  if (decoded.type === 'Issue' && decoded.number !== undefined) {
    const issue = findIssue(repo, decoded.number);
    return issue ? w('Issue', { repo, issue }) : null;
  }
  if (decoded.type === 'PullRequest' && decoded.number !== undefined) {
    const pull = findPull(repo, decoded.number);
    return pull ? w('PullRequest', { repo, pull }) : null;
  }
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => w('User', { login: VIEWER.login }),
    repository: (_data, args, state) => {
      const repo = findRepo(state.store, args.owner, args.name);
      return repo ? w('Repository', repo) : null;
    },
    node: (_data, args, state) => resolveNodeValue(state.store, args.id),
    __type: (_data, args) => {
      const info = typeof args.name === 'string' ? TYPE_INFO[args.name] : undefined;
      return info ? w('__Type', info) : null;
    },
    __schema: () => w('__Schema', {}),
  },

  Mutation: {
    createIssue: (_data, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(input.repositoryId);
      const repo = decoded !== null && decoded.type === 'Repository'
        ? findRepoByFullName(state.store, decoded.fullName)
        : undefined;
      if (!repo) {
        state.errors.push({
          message: `createIssue: repository not found for id "${String(input.repositoryId ?? '')}".`,
        });
        return w('CreateIssuePayload', { issue: null });
      }
      const number = repo.nextIssueNumber;
      repo.nextIssueNumber += 1;
      const issue = {
        id: repo.id * 1_000_000 + number,
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: state.store.tick(),
      } as unknown as Issue;
      insertIssue(repo, issue);
      return w('CreateIssuePayload', { issue: w('Issue', { repo, issue }) });
    },

    closeIssue: (_data, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subject = decodeSubjectId(state.store, input.issueId);
      const issue = subject !== null && subject.type === 'Issue'
        ? findIssue(subject.repo, subject.number)
        : undefined;
      if (!subject || !issue) {
        state.errors.push({
          message: `closeIssue: issue not found for id "${String(input.issueId ?? '')}".`,
        });
        return w('CloseIssuePayload', { issue: null });
      }
      issue.state = 'closed';
      return w('CloseIssuePayload', { issue: w('Issue', { repo: subject.repo, issue }) });
    },

    createPullRequest: (_data, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(input.repositoryId);
      const repo = decoded !== null && decoded.type === 'Repository'
        ? findRepoByFullName(state.store, decoded.fullName)
        : undefined;
      if (!repo) {
        state.errors.push({
          message: `createPullRequest: repository not found for id "${String(input.repositoryId ?? '')}".`,
        });
        return w('CreatePullRequestPayload', { pullRequest: null });
      }
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = getRefSha(repo, headRef);
      const baseSha = getRefSha(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) {
        state.errors.push({
          message: `createPullRequest: head or base ref not found (head "${headRef}", base "${baseRef}").`,
        });
        return w('CreatePullRequestPayload', { pullRequest: null });
      }
      const number = repo.nextPullNumber;
      repo.nextPullNumber += 1;
      const pull = {
        id: repo.id * 1_000_000 + number,
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        headSha,
        baseRef,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: state.store.tick(),
      } as unknown as Pull;
      insertPull(repo, pull);
      return w('CreatePullRequestPayload', { pullRequest: w('PullRequest', { repo, pull }) });
    },

    mergePullRequest: (_data, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subject = decodeSubjectId(state.store, input.pullRequestId);
      const pull = subject !== null && subject.type === 'PullRequest'
        ? findPull(subject.repo, subject.number)
        : undefined;
      if (!subject || !pull) {
        state.errors.push({
          message: `mergePullRequest: pull request not found for id "${String(input.pullRequestId ?? '')}".`,
        });
        return w('MergePullRequestPayload', { pullRequest: null });
      }
      if (!pull.merged) {
        const result = squashMerge(state.store, subject.repo, pull);
        if (!result.ok) {
          state.errors.push({ message: `mergePullRequest: ${result.error}` });
          return w('MergePullRequestPayload', { pullRequest: null });
        }
        pull.merged = true;
        pull.state = 'closed';
        (pull as unknown as Record<string, unknown>).mergedAt = state.store.isoFor(state.store.tick());
        (pull as unknown as Record<string, unknown>).mergeCommitSha = result.sha;
        pull.baseSha = result.sha;
      }
      return w('MergePullRequestPayload', { pullRequest: w('PullRequest', { repo: subject.repo, pull }) });
    },

    addComment: (_data, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subject = decodeSubjectId(state.store, input.subjectId);
      const issue = subject !== null && subject.type === 'Issue'
        ? findIssue(subject.repo, subject.number)
        : undefined;
      if (!subject || !issue) {
        state.errors.push({
          message: `addComment: issue not found for id "${String(input.subjectId ?? '')}".`,
        });
        return w('AddCommentPayload', { commentEdge: null });
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comments = (issue as unknown as { comments: unknown }).comments;
      const list: Array<Record<string, unknown>> = Array.isArray(comments)
        ? (comments as Array<Record<string, unknown>>)
        : [];
      if (!Array.isArray(comments)) {
        (issue as unknown as { comments: unknown }).comments = list;
      }
      const comment = { id: list.length + 1, body, createdSeq: state.store.tick() };
      list.push(comment);
      const nodeId = b64urlEncode(`IssueComment:${subject.repo.fullName}:${issue.number}:${comment.id}`);
      const node = w('Comment', {
        id: nodeId,
        body,
        createdAt: state.store.isoFor(comment.createdSeq),
      });
      return w('AddCommentPayload', { commentEdge: w('CommentEdge', { node }) });
    },
  },

  User: {
    login: (data) => (data as { login: string }).login,
  },

  Ref: {
    name: (data) => (data as { name: string }).name,
  },

  Repository: {
    id: (data) => repoGid(data as Repo),
    databaseId: (data) => (data as Repo).id,
    name: (data) => (data as Repo).name,
    nameWithOwner: (data) => (data as Repo).fullName,
    description: (data) => (data as Repo).description ?? '',
    owner: (data) => w('User', { login: (data as Repo).owner }),
    defaultBranchRef: (data) => w('Ref', { name: (data as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (data, args) => {
      const repo = data as Repo;
      const issue = typeof args.number === 'number' ? findIssue(repo, args.number) : undefined;
      return issue ? w('Issue', { repo, issue }) : null;
    },
    issues: (data, args) => issueConnection(data as Repo, args),
    pullRequests: (data, args) => pullConnection(data as Repo, args),
    pullRequest: (data, args) => {
      const repo = data as Repo;
      const pull = typeof args.number === 'number' ? findPull(repo, args.number) : undefined;
      return pull ? w('PullRequest', { repo, pull }) : null;
    },
  },

  Issue: {
    id: (data) => {
      const d = data as { repo: Repo; issue: Issue };
      return issueGid(d.repo, d.issue.number);
    },
    number: (data) => (data as { issue: Issue }).issue.number,
    title: (data) => (data as { issue: Issue }).issue.title,
    body: (data) => (data as { issue: Issue }).issue.body ?? '',
    state: (data) => gqlState((data as { issue: Issue }).issue.state),
    createdAt: (data, _args, state) =>
      state.store.isoFor((data as { issue: Issue }).issue.createdSeq),
  },

  PullRequest: {
    id: (data) => {
      const d = data as { repo: Repo; pull: Pull };
      return pullGid(d.repo, d.pull.number);
    },
    number: (data) => (data as { pull: Pull }).pull.number,
    title: (data) => (data as { pull: Pull }).pull.title ?? '',
    body: (data) => (data as { pull: Pull }).pull.body ?? '',
    state: (data) => {
      const pull = (data as { pull: Pull }).pull;
      return pull.merged || pull.state !== 'open' ? 'CLOSED' : 'OPEN';
    },
    headRefName: (data) => (data as { pull: Pull }).pull.headRef,
    baseRefName: (data) => (data as { pull: Pull }).pull.baseRef,
    mergeable: () => 'MERGEABLE',
    merged: (data) => Boolean((data as { pull: Pull }).pull.merged),
    files: (data, args, state) => {
      const d = data as { repo: Repo; pull: Pull };
      return filesConnection(state.store, d.repo, d.pull, args);
    },
    createdAt: (data, _args, state) =>
      state.store.isoFor((data as { pull: Pull }).pull.createdSeq),
  },

  IssueConnection: {
    nodes: (data) => {
      const d = data as { repo: Repo; items: Issue[] };
      return d.items.map((issue) => w('Issue', { repo: d.repo, issue }));
    },
    edges: (data) => {
      const d = data as { repo: Repo; items: Issue[]; offset: number };
      return d.items.map((issue, i) =>
        w('IssueEdge', {
          node: w('Issue', { repo: d.repo, issue }),
          cursor: encodeCursor(d.offset + i + 1),
        }),
      );
    },
    pageInfo: (data) => w('PageInfo', (data as { pageInfo: unknown }).pageInfo),
    totalCount: (data) => (data as { totalCount: number }).totalCount,
  },

  IssueEdge: {
    node: (data) => (data as { node: Wrapped }).node,
    cursor: (data) => (data as { cursor: string }).cursor,
  },

  PullRequestConnection: {
    nodes: (data) => {
      const d = data as { repo: Repo; items: Pull[] };
      return d.items.map((pull) => w('PullRequest', { repo: d.repo, pull }));
    },
    edges: (data) => {
      const d = data as { repo: Repo; items: Pull[]; offset: number };
      return d.items.map((pull, i) =>
        w('PullRequestEdge', {
          node: w('PullRequest', { repo: d.repo, pull }),
          cursor: encodeCursor(d.offset + i + 1),
        }),
      );
    },
    pageInfo: (data) => w('PageInfo', (data as { pageInfo: unknown }).pageInfo),
    totalCount: (data) => (data as { totalCount: number }).totalCount,
  },

  PullRequestEdge: {
    node: (data) => (data as { node: Wrapped }).node,
    cursor: (data) => (data as { cursor: string }).cursor,
  },

  PullRequestChangedFileConnection: {
    nodes: (data) =>
      (data as { items: string[] }).items.map((path) => w('PullRequestChangedFile', { path })),
    edges: (data) => {
      const d = data as { items: string[]; offset: number };
      return d.items.map((path, i) =>
        w('PullRequestChangedFileEdge', {
          node: w('PullRequestChangedFile', { path }),
          cursor: encodeCursor(d.offset + i + 1),
        }),
      );
    },
    pageInfo: (data) => w('PageInfo', (data as { pageInfo: unknown }).pageInfo),
    totalCount: (data) => (data as { totalCount: number }).totalCount,
  },

  PullRequestChangedFileEdge: {
    node: (data) => (data as { node: Wrapped }).node,
    cursor: (data) => (data as { cursor: string }).cursor,
  },

  PullRequestChangedFile: {
    path: (data) => (data as { path: string }).path,
  },

  PageInfo: {
    hasNextPage: (data) => Boolean((data as { hasNextPage: unknown }).hasNextPage),
    endCursor: (data) => (data as { endCursor: unknown }).endCursor ?? null,
    hasPreviousPage: () => false,
    startCursor: (data) => (data as { startCursor: unknown }).startCursor ?? null,
  },

  CreateIssuePayload: {
    issue: (data) => (data as { issue: Wrapped | null }).issue,
  },

  CloseIssuePayload: {
    issue: (data) => (data as { issue: Wrapped | null }).issue,
  },

  CreatePullRequestPayload: {
    pullRequest: (data) => (data as { pullRequest: Wrapped | null }).pullRequest,
  },

  MergePullRequestPayload: {
    pullRequest: (data) => (data as { pullRequest: Wrapped | null }).pullRequest,
  },

  AddCommentPayload: {
    commentEdge: (data) => (data as { commentEdge: Wrapped | null }).commentEdge,
  },

  CommentEdge: {
    node: (data) => (data as { node: Wrapped }).node,
  },

  Comment: {
    id: (data) => (data as { id: string }).id,
    body: (data) => (data as { body: string }).body,
    createdAt: (data) => (data as { createdAt?: string }).createdAt ?? null,
  },

  __Type: {
    name: (data) => (data as TypeInfo).name,
    kind: (data) => (data as TypeInfo).kind,
    description: () => null,
    fields: (data) =>
      ((data as TypeInfo).fields ?? []).map((f) => w('__Field', f)),
    enumValues: (data) =>
      ((data as TypeInfo).enumValues ?? []).map((name) => w('__EnumValue', { name })),
    interfaces: () => [],
    possibleTypes: () => null,
  },

  __Field: {
    name: (data) => (data as { name: string }).name,
    description: () => null,
    type: (data) => w('__Type', (data as { type: TypeRef }).type),
    args: () => [],
    isDeprecated: () => false,
    deprecationReason: () => null,
  },

  __EnumValue: {
    name: (data) => (data as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },

  __Schema: {
    queryType: () => w('__Type', { name: 'Query', kind: 'OBJECT', fields: TYPE_INFO.Query.fields }),
    mutationType: () =>
      w('__Type', { name: 'Mutation', kind: 'OBJECT', fields: TYPE_INFO.Mutation.fields }),
    subscriptionType: () => null,
    types: () => [
      ...Object.values(TYPE_INFO).map((info) => w('__Type', info)),
      w('__Type', { name: '__Type', kind: 'OBJECT' }),
      w('__Type', { name: '__Field', kind: 'OBJECT' }),
      w('__Type', { name: '__EnumValue', kind: 'OBJECT' }),
      w('__Type', { name: '__Schema', kind: 'OBJECT' }),
    ],
    directives: () => [],
  },
};

function resolveField(typeName: string, data: unknown, field: FieldNode, state: ExecState): unknown {
  if (field.name === '__typename') return typeName;
  const resolver = RESOLVERS[typeName]?.[field.name];
  if (!resolver) {
    state.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return undefined;
  }
  const args = evalArgs(field.arguments, state.variables);
  return resolver(data, args, state);
}

function completeValue(
  value: unknown,
  selections: SelectionNode[] | undefined,
  state: ExecState,
  depth: number,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selections, state, depth));
  if (isWrapped(value)) {
    if (selections && selections.length > 0) {
      return resolveSelectionSet(value.__typename, value.data, selections, state, depth);
    }
    return typeof value.data === 'object' ? null : value.data;
  }
  return value;
}

function resolveSelectionSet(
  typeName: string,
  data: unknown,
  selections: SelectionNode[],
  state: ExecState,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (depth > 40) return out;
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      if (isSkipped(sel.directives, state.variables)) continue;
      const frag = state.fragments.get(sel.name);
      if (!frag) {
        state.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      if (frag.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelectionSet(typeName, data, frag.selectionSet, state, depth + 1));
    } else if (sel.kind === 'inline') {
      if (isSkipped(sel.directives, state.variables)) continue;
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelectionSet(typeName, data, sel.selectionSet, state, depth + 1));
    } else {
      if (isSkipped(sel.directives, state.variables)) continue;
      const key = sel.alias ?? sel.name;
      let value: unknown;
      try {
        value = resolveField(typeName, data, sel, state);
      } catch (err) {
        state.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
        continue;
      }
      if (value === undefined) continue;
      out[key] = completeValue(value, sel.selectionSet, state, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One operation / HTTP entry point
// ---------------------------------------------------------------------------

interface OperationResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

function runOperation(entry: unknown, store: Store): OperationResult {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'Invalid operation: expected an object with query.' }] };
  }
  const { query, variables, operationName } = entry as {
    query?: unknown;
    variables?: unknown;
    operationName?: unknown;
  };
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const variablesObj =
    variables && typeof variables === 'object' && !Array.isArray(variables)
      ? (variables as Record<string, unknown>)
      : {};
  const operations = doc.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === 'operation',
  );
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of doc.definitions) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
  }
  let op: OperationDefinitionNode | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    op = operations.find((o) => o.name === operationName);
    if (!op) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (operations.length === 1) {
    op = operations[0];
  } else if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in document.' }] };
  } else {
    return {
      data: null,
      errors: [{ message: 'Must provide operation name if query contains multiple operations.' }],
    };
  }
  if (op.operation === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  const allVars: Record<string, unknown> = { ...variablesObj };
  for (const vd of op.variableDefinitions) {
    if ((allVars[vd.name] === undefined || allVars[vd.name] === null) && vd.defaultValue !== undefined) {
      allVars[vd.name] = evalValue(vd.defaultValue, {});
    }
  }
  const state: ExecState = { store, variables: allVars, errors: [], fragments };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelectionSet(rootType, null, op.selectionSet, state, 0);
  const out: OperationResult = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

export function handleGraphql(ctx: ReqCtx, store: Store): Resp | null {
  if (ctx.path !== '/api/graphql') return null;
  if (ctx.method !== 'POST') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, headers: JSON_HEADERS, body: { errors: [{ message: 'Request body must be valid JSON.' }] } };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return {
        status: 400,
        headers: JSON_HEADERS,
        body: { errors: [{ message: 'Batch must contain at least one operation.' }] },
      };
    }
    return { status: 200, headers: JSON_HEADERS, body: parsed.map((entry) => runOperation(entry, store)) };
  }
  return { status: 200, headers: JSON_HEADERS, body: runOperation(parsed, store) };
}
