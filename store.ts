// Single in-memory store: source of truth for REST / GraphQL / MCP / git.
// Deterministic: no Date.now() / Math.random() here except parsing
// MAKEFUN_TRIAL_NOW once in the constructor. Time comes from trialNowMs,
// ordering comes from the monotonic seq counter.
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Scenario identity (reimplemented from the suite's wire.ts seed logic)
// ---------------------------------------------------------------------------

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';
export const U64_MASK = 0xffffffffffffffffn;
/** 2025-01-01T00:00:00Z: every scenario timestamp is this plus a seeded offset. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;
export const DEFAULT_BRANCH = 'main';
export const ORG_LOGIN = 'faint-meadow-org';

/** FNV-1a, 64-bit: a label's stable seed contribution. */
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: deterministic PRNG, no hidden state but #state. */
export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  /** A stream from a label (scenarioSeedFor) under this scenario's seed. */
  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }

  /** An independent stream from this one's current state. */
  clone(): Rng {
    return new Rng(this.#state);
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of nextU64(). */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    }
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** A number in [0, 1), 32 bits of resolution. */
  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  /** True with probability `probability`. */
  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  /** One element, uniformly (an Error on an empty list). */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)];
  }

  /** A shuffled copy, Fisher-Yates. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }

  /** `length` bytes. */
  bytes(length: number): Uint8Array {
    const size = Number.isSafeInteger(length) ? Math.max(0, length) : 0;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 4) {
      const word = this.nextU32();
      out[i] = word & 0xff;
      if (i + 1 < size) out[i + 1] = (word >>> 8) & 0xff;
      if (i + 2 < size) out[i + 2] = (word >>> 16) & 0xff;
      if (i + 3 < size) out[i + 3] = (word >>> 24) & 0xff;
    }
    return out;
  }

  /** `length` lowercase hex characters. */
  hex(length: number): string {
    const digits = '0123456789abcdef';
    let out = '';
    while (out.length < length) out += digits[this.nextInt(16)];
    return out;
  }

  /** `count` picks from `list`, in order. */
  words(count: number, list: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) out.push(this.pick(list));
    return out;
  }
}

/** A named stream: same label, same numbers, in any process and any order of use. */
export function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** `count` users with unique logins, deterministic for `rng`. */
export function generateUsers(rng: Rng, count: number): User[] {
  const used = new Set<string>();
  const users: User[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The scenario viewer, derived from the seed (must be adaiversen). */
export function scenarioViewer(): User {
  return generateUsers(scenarioRng('users'), 12)[0];
}

export const VIEWER: User = scenarioViewer();
if (VIEWER.login !== 'adaiversen') {
  throw new Error(`scenario seed mismatch: viewer is ${VIEWER.login}, expected adaiversen`);
}
const SCENARIO_USERS: User[] = generateUsers(scenarioRng('users'), 12);
export const TEAMMATE: User = SCENARIO_USERS[1];
export const STRANGER: User = SCENARIO_USERS[2];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullNumber: number;
  createdSeq: number;
}

// GitHub's six default labels.
const DEFAULT_LABELS: Label[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

// ---------------------------------------------------------------------------
// Line-diff helpers (diffTrees)
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function isBinary(data: Buffer): boolean {
  return data.length > 200 * 1024 || data.includes(0);
}

/** LCS length of two line arrays, O(n*m) time, O(m) memory. */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  repos: Map<string, Repo> = new Map();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  seq = 0;
  trialNowMs: number;
  /**
   * Monotonic mutation counter: bumped on every object write and every ref
   * write (see putObject / createRepo / deleteRepo / bumpVersion). The git
   * pack cache keys on it, so any mutation invalidates every cached pack.
   * It never enters any API response or state export.
   */
  version = 0;
  /**
   * Cache of built fetch packs, keyed by the full fetch inputs plus
   * `version` (see git.ts computeFetch). A cached pack is byte-identical to
   * a freshly built one for the same inputs, so this is a pure memo: it
   * cannot change any response, only skip redundant deflate work. Capped so
   * a long trial cannot grow it without bound (oldest entry evicted first).
   */
  packCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();

  constructor() {
    if (VIEWER.login !== 'adaiversen') {
      throw new Error(`scenario seed mismatch: viewer is ${VIEWER.login}, expected adaiversen`);
    }
    // The one place wall-clock-shaped input is read: parse env once.
    const raw = process.env.MAKEFUN_TRIAL_NOW;
    let parsed = SCENARIO_EPOCH_SEC * 1000;
    if (raw !== undefined && raw.trim() !== '') {
      const trimmed = raw.trim();
      if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
        const ms = Number(trimmed);
        if (Number.isFinite(ms)) parsed = ms;
      } else {
        const ms = Date.parse(trimmed);
        if (Number.isFinite(ms)) parsed = ms;
      }
    }
    this.trialNowMs = parsed;
  }

  /** Advance the mutation counter (ref writes call this; object writes bump inside putObject). */
  bumpVersion(): void {
    this.version += 1;
  }

  /** Advance the monotonic counter and return the new value. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** ISO timestamp for a given seq: trialNow + seq seconds. */
  isoFor(seq: number): string {
    return new Date(this.trialNowMs + seq * 1000).toISOString();
  }

  /** Epoch seconds for a given seq: trialNow epoch + seq. */
  epochSecFor(seq: number): number {
    return Math.floor(this.trialNowMs / 1000) + seq;
  }

  // -- repos ---------------------------------------------------------------

  createRepo(
    owner: string,
    name: string,
    opts?: { description?: string; private?: boolean; defaultBranch?: string },
  ): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: opts?.description ?? '',
      private: opts?.private ?? false,
      defaultBranch: opts?.defaultBranch ?? DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(DEFAULT_LABELS.map((l) => [l.name, { ...l }])),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      createdSeq: this.tick(),
    };
    this.nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    this.bumpVersion();
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    const deleted = this.repos.delete(`${owner}/${name}`);
    if (deleted) this.bumpVersion();
    return deleted;
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  // -- git objects ---------------------------------------------------------

  hashObject(type: ObjectType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    return createHash('sha1').update(header).update(data).digest('hex');
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const sha = this.hashObject(type, data);
    if (!repo.objects.has(sha)) {
      repo.objects.set(sha, { type, data });
      this.bumpVersion();
    }
    return sha;
  }

  /**
   * Store an object whose SHA-1 the caller already computed (receive-pack:
   * readPack hashed every object while resolving the pack). Identical result
   * to putObject, minus the redundant hash. Only call with a verified sha.
   */
  putObjectKnownSha(repo: Repo, type: ObjectType, data: Buffer, sha: string): void {
    if (!repo.objects.has(sha)) {
      repo.objects.set(sha, { type, data });
      this.bumpVersion();
    }
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  hasObject(repo: Repo, sha: string): boolean {
    return repo.objects.has(sha);
  }

  // -- trees ---------------------------------------------------------------

  private static treeSortKey(entry: TreeEntry): string {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    return isDir ? `${entry.name}/` : entry.name;
  }

  makeTree(repo: Repo, entries: TreeEntry[]): string {
    const sorted = entries.slice().sort((a, b) => {
      const ka = Store.treeSortKey(a);
      const kb = Store.treeSortKey(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return 0;
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.sha, 'hex'));
    }
    return this.putObject(repo, 'tree', Buffer.concat(parts));
  }

  parseTree(data: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(0x20, offset);
      if (space === -1) break;
      const mode = data.toString('utf8', offset, space);
      const nul = data.indexOf(0x00, space + 1);
      if (nul === -1) break;
      const name = data.toString('utf8', space + 1, nul);
      if (nul + 21 > data.length) break;
      const sha = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, sha });
      offset = nul + 21;
    }
    return entries;
  }

  // -- commits -------------------------------------------------------------

  makeCommit(repo: Repo, info: CommitInfo): string {
    let text = `tree ${info.tree}\n`;
    for (const p of info.parents) text += `parent ${p}\n`;
    text += `author ${info.author}\n`;
    text += `committer ${info.committer}\n`;
    text += `\n${info.message}`;
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  parseCommit(data: Buffer): CommitInfo {
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    const header = split === -1 ? text : text.slice(0, split);
    const message = split === -1 ? '' : text.slice(split + 2);
    const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) info.tree = line.slice(5);
      else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
      else if (line.startsWith('author ')) info.author = line.slice(7);
      else if (line.startsWith('committer ')) info.committer = line.slice(10);
    }
    return info;
  }

  // -- tags ----------------------------------------------------------------

  makeTag(repo: Repo, info: TagInfo): string {
    const text =
      `object ${info.object}\n` +
      `type ${info.type}\n` +
      `tag ${info.tag}\n` +
      `tagger ${info.tagger}\n` +
      `\n${info.message}`;
    return this.putObject(repo, 'tag', Buffer.from(text, 'utf8'));
  }

  parseTag(data: Buffer): TagInfo {
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    const header = split === -1 ? text : text.slice(0, split);
    const message = split === -1 ? '' : text.slice(split + 2);
    const info: TagInfo = { object: '', type: 'commit', tag: '', tagger: '', message };
    for (const line of header.split('\n')) {
      if (line.startsWith('object ')) info.object = line.slice(7);
      else if (line.startsWith('type ')) info.type = line.slice(5) as ObjectType;
      else if (line.startsWith('tag ')) info.tag = line.slice(4);
      else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
    }
    return info;
  }

  // -- tree walking ----------------------------------------------------------

  listTreeRecursive(repo: Repo, treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const obj = treeSha ? this.getObject(repo, treeSha) : undefined;
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of this.parseTree(obj.data)) {
      const path = prefix + entry.name;
      if (entry.mode === '40000' || entry.mode === '040000') {
        for (const [p, v] of this.listTreeRecursive(repo, entry.sha, `${path}/`)) out.set(p, v);
      } else if (entry.mode === '160000') {
        // gitlink: not a file, skip.
      } else {
        out.set(path, { mode: entry.mode, sha: entry.sha });
      }
    }
    return out;
  }

  getBlobAtPath(repo: Repo, commitSha: string, path: string): { sha: string; data: Buffer } | undefined {
    const commitObj = this.getObject(repo, commitSha);
    if (!commitObj || commitObj.type !== 'commit') return undefined;
    const info = this.parseCommit(commitObj.data);
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) return undefined;
    let treeSha = info.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const treeObj = this.getObject(repo, treeSha);
      if (!treeObj || treeObj.type !== 'tree') return undefined;
      const entry = this.parseTree(treeObj.data).find((e) => e.name === segments[i]);
      if (!entry) return undefined;
      const last = i === segments.length - 1;
      if (last) {
        if (entry.mode === '40000' || entry.mode === '040000' || entry.mode === '160000') return undefined;
        const blob = this.getObject(repo, entry.sha);
        if (!blob) return undefined;
        return { sha: entry.sha, data: blob.data };
      }
      if (entry.mode !== '40000' && entry.mode !== '040000') return undefined;
      treeSha = entry.sha;
    }
    return undefined;
  }

  // -- history ---------------------------------------------------------------

  listCommits(repo: Repo, tipSha: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>([tipSha]);
    const stack: string[] = [tipSha];
    while (stack.length > 0 && out.length < limit) {
      const sha = stack.pop() as string;
      out.push(sha);
      const obj = this.getObject(repo, sha);
      if (!obj || obj.type !== 'commit') continue;
      const parents = this.parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) {
        if (!seen.has(parents[i])) {
          seen.add(parents[i]);
          stack.push(parents[i]);
        }
      }
    }
    return out;
  }

  ancestors(repo: Repo, sha: string): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [sha];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (out.has(cur)) continue;
      out.add(cur);
      const obj = this.getObject(repo, cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) {
        if (!out.has(p)) stack.push(p);
      }
    }
    return out;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = this.ancestors(repo, a);
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (ancestorsA.has(cur)) return cur;
      const obj = this.getObject(repo, cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) {
        if (!seen.has(p)) queue.push(p);
      }
    }
    return null;
  }

  /**
   * True when `anc` is reachable from `desc` by following parents. Unlike
   * ancestors() this stops the moment `anc` is found, so the common
   * fast-forward case (old tip = direct parent of the new tip) costs one
   * commit parse instead of a full-history walk.
   */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>([desc]);
    const stack: string[] = [desc];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      const obj = this.getObject(repo, cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) {
        if (p === anc) return true;
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return false;
  }

  isFastForward(repo: Repo, oldSha: string | null, newSha: string): boolean {
    if (oldSha === null) return true;
    if (oldSha === newSha) return true;
    return this.isAncestor(repo, oldSha, newSha);
  }

  // -- diff ------------------------------------------------------------------

  diffTrees(repo: Repo, baseTreeSha: string, headTreeSha: string): FileChange[] {
    const base = this.listTreeRecursive(repo, baseTreeSha);
    const head = this.listTreeRecursive(repo, headTreeSha);
    const names = new Set<string>([...base.keys(), ...head.keys()]);
    const sorted = [...names].sort();
    const out: FileChange[] = [];
    for (const filename of sorted) {
      const b = base.get(filename);
      const h = head.get(filename);
      if (b && !h) {
        const data = this.getObject(repo, b.sha)?.data ?? Buffer.alloc(0);
        const deletions = splitLines(data.toString('utf8')).length;
        out.push({ filename, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const data = this.getObject(repo, h.sha)?.data ?? Buffer.alloc(0);
        const additions = splitLines(data.toString('utf8')).length;
        out.push({ filename, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && h && (b.sha !== h.sha || b.mode !== h.mode)) {
        const baseData = this.getObject(repo, b.sha)?.data ?? Buffer.alloc(0);
        const headData = this.getObject(repo, h.sha)?.data ?? Buffer.alloc(0);
        let additions: number;
        let deletions: number;
        if (isBinary(baseData) || isBinary(headData)) {
          additions = 1;
          deletions = 1;
        } else {
          const baseLines = splitLines(baseData.toString('utf8'));
          const headLines = splitLines(headData.toString('utf8'));
          const common = lcsLength(baseLines, headLines);
          additions = headLines.length - common;
          deletions = baseLines.length - common;
        }
        out.push({ filename, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }
}
