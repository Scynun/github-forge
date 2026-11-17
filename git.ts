// git.ts — Git smart-HTTP server for the make.fun github-core-clone-01 forge.
//
// Serves: GET info/refs (v2 advertisement for git-upload-pack when the request
// carries `Git-Protocol: version=2`, v0 otherwise; receive-pack is v0-only),
// POST git-upload-pack (protocol v2: ls-refs + fetch with sections; v0 fallback:
// want/have/done with side-band-64k), POST git-receive-pack (v0-only, command
// list + raw pack, report-status wrapped in side-band-64k when negotiated).
//
// Ground truth (every byte-level decision follows what the reference client's
// parsers accept — see build-notes/git-contract.md and
// github-core-clone-01-kit/.../program/env/src/git-client.ts):
// - pkt-line: 4 lowercase-hex length incl. header, max 65520 total; 0000 flush,
//   0001 delim, 0002 response-end. Side-band-64k: one band byte (1 = data,
//   2 = progress, 3 = error) + payload, each pkt-line <= 65520 bytes.
// - info/refs body starts with the `# service=<service>` preamble pkt-line +
//   flush (the advertise-headers check requires it for v0 upload-pack and for
//   receive-pack; v2 accepts it before the `version 2` line).
// - v2 advertisement: `version 2`, `agent=…`, `ls-refs=unborn`, `fetch=shallow`,
//   `object-format=sha1`. ls-refs responses carry NO `version 2` line — the
//   client's ls-refs parser treats every data packet as a ref line.
// - v2 fetch response sections, in order: acknowledgments, shallow-info,
//   wanted-refs, packfile — each ended by delim, the whole response by flush.
//   The packfile section always carries >= 1 side-band packet, even for an
//   empty (0-object) pack. Pack: PACK v2, plain objects (no deltas), zlib per
//   object, trailer = SHA-1 of everything before it.
// - v0 fetch response: plain pkt-line `NAK`, optional `shallow`/`unshallow`
//   lines, then side-band pack packets, then flush.
// - receive-pack: command list pkt-lines (first line carries capabilities
//   after NUL), flush, then the raw pack bytes. Delete-only pushes carry no
//   pack. The report-status stream (`unpack ok`, `ok <ref>` / `ng <ref>
//   <reason>`, flush) goes inside side-band band 1 when side-band-64k was
//   negotiated, raw otherwise. Non-fast-forward refusals report the exact
//   reason `non-fast-forward`.
// - Shallow: `deepen <n>` walks n generations from each want; a commit whose
//   parents were not walked is a new `shallow` boundary; a previous boundary
//   whose parents are now walked is `unshallow`. Objects reachable from
//   `have`s are never re-sent (fetch-incremental / fetch-nothing-new).
// - The server never re-serializes objects it did not create: pushed commit /
//   tree / tag bytes are stored verbatim (only their SHA-1 is recomputed).
// - No Date.now() / Math.random() anywhere; no global mutable state, so
//   concurrent clones on one repo do not race.
//
// STORE ASSUMPTIONS (store.ts is built by a sibling module; reconcile these
// if its real shape differs — the code degrades gracefully, see below):
// - `Store` exposes putObject(repo, type, data): string, getObject(repo, sha),
//   hasObject(repo, sha), parseTree(data), parseCommit(data),
//   ancestors(repo, sha): Set<string>, isFastForward(repo, old, new).
// - Repo lookup: `store.getRepo(owner, name)` (fallbacks: findRepo /
//   getRepository / findRepository / repo(), then a `store.repos` Map or
//   record keyed `owner/name`). A missing repo answers HTTP 404.
// - Refs: `repo.refs` as a live Map<string, string> (preferred), else a plain
//   record, else getRef/setRef/deleteRef/listRefs methods. Default branch:
//   `repo.defaultBranch` / `repo.default_branch` (else `head` if it is a
//   refs/heads/* name, else `main`).
// - parseTree entries carry `{mode, name, oid}` (an `sha` field is accepted
//   too); parseCommit carries `{tree, parents}`.

import { Store, VIEWER, type Repo } from './store.ts';
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

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

// VIEWER is part of the store contract import; git endpoints do not need the
// viewer's identity (object bytes carry their own author/committer), so it is
// intentionally unused here.
void VIEWER;

const ZERO_OID = '0'.repeat(40);
const PKT_LINE_MAX = 65520;
const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
const AGENT = 'makefun-git-forge/1.0';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json; charset=utf-8';

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/**
 * Scan pkt-lines from `buf` starting at `start`. With `stopAtFlush` it stops
 * just after the first flush (receive-pack: raw pack bytes follow the flush
 * and must NOT be scanned as pkt-lines). Without it, it scans to the end of
 * the buffer. Throws on malformed framing instead of returning bogus packets.
 */
function scanPackets(buf: Buffer, start: number, stopAtFlush: boolean): { packets: Packet[]; end: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
    }
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buf.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, end: offset };
}

/** The text of every data packet, in order (control packets dropped). */
function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function jsonResp(status: number, body: object): Resp {
  return { status, headers: { 'content-type': JSON_TYPE }, body };
}

function notFound(): Resp {
  return jsonResp(404, { message: 'Not Found' });
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) return headers[key];
  return undefined;
}

function wantsV2(ctx: ReqCtx): boolean {
  const value = headerOf(ctx.headers, 'git-protocol');
  return value !== undefined && value.trim().toLowerCase() === 'version=2';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// store access: repo lookup, refs, default branch (see the header assumptions)
// ---------------------------------------------------------------------------------------------

function lookupRepo(store: Store, owner: string, name: string): Repo | undefined {
  const s = store as unknown as Record<string, unknown>;
  for (const fn of ['getRepo', 'findRepo', 'getRepository', 'findRepository', 'repo']) {
    const f = s[fn];
    if (typeof f === 'function') {
      try {
        const found = (f as (o: string, n: string) => unknown).call(store, owner, name);
        if (found) return found as Repo;
      } catch {
        // Try the next lookup shape.
      }
    }
  }
  const repos = s.repos;
  if (repos instanceof Map) {
    const hit = repos.get(`${owner}/${name}`) ?? repos.get(`${owner}:${name}`);
    if (hit) return hit as Repo;
  } else if (repos && typeof repos === 'object') {
    const rec = repos as Record<string, unknown>;
    const direct = rec[`${owner}/${name}`] ?? rec[`${owner}:${name}`];
    if (direct) return direct as Repo;
    const byOwner = rec[owner];
    if (byOwner && typeof byOwner === 'object') {
      const hit = (byOwner as Record<string, unknown>)[name];
      if (hit) return hit as Repo;
    }
  }
  return undefined;
}

interface RefsAccess {
  get(name: string): string | undefined;
  set(name: string, sha: string): void;
  delete(name: string): void;
  entries(): Array<[string, string]>;
  size(): number;
}

const fallbackRefs = new WeakMap<object, Map<string, string>>();

function isStringPair(entry: [string, unknown]): entry is [string, string] {
  return typeof entry[0] === 'string' && typeof entry[1] === 'string';
}

/** Ref storage behind one access shape. Prefers a live `refs` Map, then a live `refs` record, then getRef/setRef/listRefs methods. */
function refsAccess(repo: Repo): RefsAccess {
  const r = repo as unknown as Record<string, unknown>;
  if (r.refs instanceof Map) {
    const map = r.refs as Map<string, string>;
    return {
      get: (name) => map.get(name),
      set: (name, sha) => {
        map.set(name, sha);
      },
      delete: (name) => {
        map.delete(name);
      },
      entries: () => [...map.entries()].filter(isStringPair),
      size: () => map.size,
    };
  }
  if (r.refs && typeof r.refs === 'object') {
    const rec = r.refs as Record<string, unknown>;
    return {
      get: (name) => (typeof rec[name] === 'string' ? (rec[name] as string) : undefined),
      set: (name, sha) => {
        rec[name] = sha;
      },
      delete: (name) => {
        delete rec[name];
      },
      entries: () => Object.entries(rec).filter(isStringPair),
      size: () => Object.keys(rec).length,
    };
  }
  if (typeof r.getRef === 'function' && typeof r.setRef === 'function') {
    const getRef = r.getRef as (name: string) => unknown;
    const setRef = r.setRef as (name: string, sha: string | null) => unknown;
    const listRefs = typeof r.listRefs === 'function' ? (r.listRefs as () => unknown) : null;
    const entriesFn = (): Array<[string, string]> => {
      if (!listRefs) return [];
      const value = listRefs.call(repo);
      if (value instanceof Map) return [...value.entries()].filter(isStringPair);
      if (Array.isArray(value)) {
        const out: Array<[string, string]> = [];
        for (const item of value) {
          if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
            out.push([item[0], item[1]]);
          } else if (item && typeof item === 'object') {
            const itemRec = item as Record<string, unknown>;
            const name = itemRec.name ?? itemRec.ref;
            const sha = itemRec.sha ?? itemRec.oid;
            if (typeof name === 'string' && typeof sha === 'string') out.push([name, sha]);
          }
        }
        return out;
      }
      return [];
    };
    return {
      get: (name) => {
        const value = getRef.call(repo, name);
        return typeof value === 'string' ? value : undefined;
      },
      set: (name, sha) => {
        setRef.call(repo, name, sha);
      },
      delete: (name) => {
        if (typeof r.deleteRef === 'function') (r.deleteRef as (x: string) => unknown).call(repo, name);
        else setRef.call(repo, name, null);
      },
      entries: entriesFn,
      size: () => entriesFn().length,
    };
  }
  // Last resort: refs live only in this module's memory (invisible to REST).
  // Used only if the store exposes no ref storage at all.
  let map = fallbackRefs.get(repo as object);
  if (!map) {
    map = new Map<string, string>();
    fallbackRefs.set(repo as object, map);
  }
  const held = map;
  return {
    get: (name) => held.get(name),
    set: (name, sha) => {
      held.set(name, sha);
    },
    delete: (name) => {
      held.delete(name);
    },
    entries: () => [...held.entries()],
    size: () => held.size,
  };
}

function defaultBranch(repo: Repo): string {
  const r = repo as unknown as Record<string, unknown>;
  for (const key of ['defaultBranch', 'default_branch']) {
    const value = r[key];
    if (typeof value === 'string' && value) {
      return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
    }
  }
  const head = r.head;
  if (typeof head === 'string' && head.startsWith('refs/heads/')) return head.slice('refs/heads/'.length);
  return 'main';
}

// ---------------------------------------------------------------------------------------------
// object-model helpers (read-only walks over the store)
// ---------------------------------------------------------------------------------------------

function entryOid(entry: unknown): string {
  const rec = entry as Record<string, unknown> | null;
  if (!rec) return '';
  if (typeof rec.oid === 'string') return rec.oid;
  if (typeof rec.sha === 'string') return rec.sha;
  return '';
}

function commitTreeOf(store: Store, data: Buffer): string {
  try {
    const info = store.parseCommit(data) as unknown as Record<string, unknown>;
    return typeof info.tree === 'string' ? info.tree : '';
  } catch {
    return '';
  }
}

function commitParentsOf(store: Store, data: Buffer): string[] {
  try {
    const info = store.parseCommit(data) as unknown as Record<string, unknown>;
    const parents = info.parents;
    return Array.isArray(parents) ? parents.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Unix timestamp from a commit's author line (`author … <ts> <tz>`), if parseable. */
function commitTimestamp(data: Buffer): number | undefined {
  const text = data.subarray(0, Math.min(data.length, 4096)).toString('utf8');
  const match = /^author .* (\d+) [+-]\d{4}$/m.exec(text) ?? /^committer .* (\d+) [+-]\d{4}$/m.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Follow a tag chain. Returns the intermediate tag oids and the final non-tag object. */
function resolveTag(store: Store, repo: Repo, tagOid: string): { tags: string[]; oid: string; type: ObjType | '' } {
  const tags: string[] = [];
  let current = tagOid;
  for (let i = 0; i < 16; i += 1) {
    const obj = store.getObject(repo, current);
    if (!obj || obj.type !== 'tag') return { tags, oid: current, type: obj ? (obj.type as ObjType) : '' };
    tags.push(current);
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!match) return { tags, oid: current, type: 'tag' };
    current = match[1];
  }
  return { tags, oid: current, type: 'tag' };
}

/** The commit a ref peels to (following tag chains), or '' when the target is not a commit. */
function peelToCommit(store: Store, repo: Repo, oid: string): string {
  const resolved = resolveTag(store, repo, oid);
  return resolved.type === 'commit' ? resolved.oid : '';
}

/** Collect a tree and everything under it (trees + blobs) into `into`. Gitlinks are skipped. */
function collectTreeObjects(
  store: Store,
  repo: Repo,
  treeSha: string,
  into: Map<string, { type: ObjType; data: Buffer }>,
): void {
  const stack: string[] = [treeSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (into.has(sha)) continue;
    const obj = store.getObject(repo, sha);
    if (!obj || obj.type !== 'tree') continue;
    into.set(sha, { type: 'tree', data: obj.data });
    let entries: unknown[] = [];
    try {
      entries = store.parseTree(obj.data) as unknown[];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const oid = entryOid(entry);
      if (!oid || oid === ZERO_OID) continue;
      const mode = (entry as { mode?: unknown }).mode;
      if (mode === '160000') continue;
      if (mode === '40000') {
        stack.push(oid);
        continue;
      }
      if (!into.has(oid)) {
        const blob = store.getObject(repo, oid);
        if (blob) into.set(oid, { type: blob.type as ObjType, data: blob.data });
      }
    }
  }
}

/** Oid-only version of collectTreeObjects, for have-closures (no blob data needed). */
function collectTreeOids(store: Store, repo: Repo, treeSha: string, into: Set<string>): void {
  const stack: string[] = [treeSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (into.has(sha)) continue;
    const obj = store.getObject(repo, sha);
    if (!obj || obj.type !== 'tree') continue;
    into.add(sha);
    let entries: unknown[] = [];
    try {
      entries = store.parseTree(obj.data) as unknown[];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const oid = entryOid(entry);
      if (!oid || oid === ZERO_OID) continue;
      const mode = (entry as { mode?: unknown }).mode;
      if (mode === '160000') continue;
      if (mode === '40000') stack.push(oid);
      else into.add(oid);
    }
  }
}

interface WalkOpts {
  maxDepth?: number;
  exclude?: Set<string>;
  since?: number;
}

/**
 * Breadth-first walk from `roots` (generation 1 = the roots). Returns oid ->
 * generation. Stops expanding at `maxDepth`, never enters `exclude`, and
 * drops commits older than `since` (deepen-since: such a commit is not walked
 * and its children become the boundary).
 */
function walkCommits(store: Store, repo: Repo, roots: readonly string[], opts: WalkOpts): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!HEX40.test(root) || depth.has(root) || opts.exclude?.has(root)) continue;
    depth.set(root, 1);
    queue.push(root);
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    const generation = depth.get(oid)!;
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') {
      depth.delete(oid);
      continue;
    }
    if (opts.since !== undefined) {
      const timestamp = commitTimestamp(obj.data);
      if (timestamp !== undefined && timestamp < opts.since) {
        depth.delete(oid);
        continue;
      }
    }
    if (opts.maxDepth !== undefined && generation >= opts.maxDepth) continue;
    for (const parent of commitParentsOf(store, obj.data)) {
      if (!HEX40.test(parent) || depth.has(parent) || opts.exclude?.has(parent)) continue;
      depth.set(parent, generation + 1);
      queue.push(parent);
    }
  }
  return depth;
}

/** Every object reachable from `haves` (full ancestry): the oids, and the commit subset.
 * `shallow` is the client's current shallow boundary: a boundary commit is held
 * by the client, but its ancestors are NOT — so ancestors of a boundary (other
 * than the boundary itself) are excluded from the closure. Without this, a
 * deepen would conclude the client already has the very parents it is asking
 * for, and send nothing. */
function haveClosure(
  store: Store,
  repo: Repo,
  haves: readonly string[],
  shallow: ReadonlySet<string> = new Set<string>(),
): { all: Set<string>; commits: Set<string> } {
  const all = new Set<string>();
  const commits = new Set<string>();
  const blocked = new Set<string>();
  for (const boundary of shallow) {
    if (!HEX40.test(boundary) || boundary === ZERO_OID) continue;
    try {
      for (const ancestor of store.ancestors(repo, boundary)) {
        if (ancestor !== boundary) blocked.add(ancestor);
      }
    } catch {
      // Unknown boundary: nothing to exclude.
    }
  }
  for (const have of haves) {
    if (!HEX40.test(have) || have === ZERO_OID) continue;
    const obj = store.getObject(repo, have);
    if (!obj) continue;
    if (obj.type === 'commit') {
      let ancestors: Set<string>;
      try {
        ancestors = store.ancestors(repo, have);
      } catch {
        ancestors = new Set<string>();
      }
      const set = new Set<string>(ancestors);
      set.add(have);
      for (const oid of blocked) set.delete(oid);
      for (const commit of set) {
        if (all.has(commit)) {
          commits.add(commit);
          continue;
        }
        all.add(commit);
        commits.add(commit);
        const commitObj = store.getObject(repo, commit);
        if (commitObj && commitObj.type === 'commit') {
          const tree = commitTreeOf(store, commitObj.data);
          if (tree) collectTreeOids(store, repo, tree, all);
        }
      }
    } else if (obj.type === 'tag') {
      const resolved = resolveTag(store, repo, have);
      for (const tag of resolved.tags) all.add(tag);
      if (resolved.type === 'commit') {
        const sub = haveClosure(store, repo, [resolved.oid], shallow);
        for (const oid of sub.all) all.add(oid);
        for (const oid of sub.commits) commits.add(oid);
      } else if (resolved.type === 'tree') {
        collectTreeOids(store, repo, resolved.oid, all);
      } else if (resolved.oid) {
        all.add(resolved.oid);
      }
    } else if (obj.type === 'tree') {
      collectTreeOids(store, repo, have, all);
    } else {
      all.add(have);
    }
  }
  return { all, commits };
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

interface FetchPlan {
  shallow: string[];
  unshallow: string[];
  /** The serialized pack for the fetched objects (built here, so a cache hit skips deflate entirely). */
  pack: Buffer;
}

/** Entries kept in Store.packCache (32 max, oldest evicted first). */
const PACK_CACHE_MAX = 32;

/**
 * Cache key for a fetch plan. Every input the plan depends on is in the key:
 * the repo, the store version (any object/ref write bumps it), and the exact
 * fetch arguments with deepen-not refs resolved to the oids they point at.
 * A different argument order is a different key (a miss, never a wrong hit).
 */
function fetchCacheKey(
  store: Store,
  repo: Repo,
  args: FetchArgs,
  deepenNotOids: readonly string[],
): string {
  return [
    repo.fullName,
    String(store.version),
    args.wants.join(','),
    args.haves.join(','),
    args.shallow.join(','),
    args.depth === undefined ? '' : String(args.depth),
    args.deepenSince === undefined ? '' : String(args.deepenSince),
    deepenNotOids.join(','),
  ].join('|');
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // v0 puts the feature list on the first want line: take the first token.
      const oid = line.slice(5).trim().split(' ')[0] ?? '';
      if (HEX40.test(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (HEX40.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (HEX40.test(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      args.deepenNot.push(line.slice(11).trim());
    }
    // thin-pack / no-progress / ofs-delta / filter / done / agent /
    // object-format / command= lines carry no fetch semantics here.
  }
  args.wants = [...new Set(args.wants)];
  args.haves = [...new Set(args.haves)];
  return args;
}

function computeFetch(store: Store, repo: Repo, args: FetchArgs, refs: RefsAccess): FetchPlan {
  // Resolve deepen-not refs first: the cache key needs the oids they point
  // at, not the ref names (a ref can move; its oid at fetch time is the input).
  const deepenNotOids: string[] = [];
  const exclude = new Set<string>();
  for (const ref of args.deepenNot) {
    const oid = refs.get(ref);
    if (!oid || oid === ZERO_OID) continue;
    deepenNotOids.push(oid);
    exclude.add(oid);
    try {
      for (const ancestor of store.ancestors(repo, oid)) exclude.add(ancestor);
    } catch {
      // Unknown ref tip: nothing to exclude.
    }
  }

  // Memo: an identical fetch against an unchanged store rebuilds nothing.
  // The pack bytes are a deterministic function of these inputs (deflate is
  // deterministic for fixed input + level), so a hit is byte-identical to a
  // fresh build. The wanted-refs section is NOT cached (it reads live refs)
  // and is rebuilt by the caller on every fetch.
  const key = fetchCacheKey(store, repo, args, deepenNotOids);
  const hit = store.packCache.get(key);
  if (hit) {
    return { shallow: hit.shallow, unshallow: hit.unshallow, pack: hit.pack };
  }

  const send = new Map<string, { type: ObjType; data: Buffer }>();
  const walkRoots: string[] = [];
  for (const want of args.wants) {
    if (!HEX40.test(want) || want === ZERO_OID) continue;
    const obj = store.getObject(repo, want);
    if (!obj) continue;
    if (obj.type === 'commit') {
      walkRoots.push(want);
    } else if (obj.type === 'tag') {
      send.set(want, { type: 'tag', data: obj.data });
      const resolved = resolveTag(store, repo, want);
      for (const tag of resolved.tags) {
        if (tag === want) continue;
        const tagObj = store.getObject(repo, tag);
        if (tagObj) send.set(tag, { type: 'tag', data: tagObj.data });
      }
      if (resolved.type === 'commit') walkRoots.push(resolved.oid);
      else if (resolved.type === 'tree') collectTreeObjects(store, repo, resolved.oid, send);
      else if (resolved.type === 'blob' || resolved.type === 'tag') {
        const target = store.getObject(repo, resolved.oid);
        if (target) send.set(resolved.oid, { type: target.type as ObjType, data: target.data });
      }
    } else if (obj.type === 'tree') {
      collectTreeObjects(store, repo, want, send);
    } else {
      send.set(want, { type: obj.type as ObjType, data: obj.data });
    }
  }

  const have = haveClosure(store, repo, args.haves, new Set(args.shallow));
  const walked = walkCommits(store, repo, walkRoots, {
    maxDepth: args.depth,
    exclude: exclude.size ? exclude : undefined,
    since: args.deepenSince,
  });
  for (const oid of walked.keys()) {
    if (have.commits.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (!obj) continue;
    send.set(oid, { type: obj.type as ObjType, data: obj.data });
    if (obj.type === 'commit') {
      const tree = commitTreeOf(store, obj.data);
      if (tree) collectTreeObjects(store, repo, tree, send);
    }
  }
  // Never re-send what the client already has.
  for (const oid of have.all) send.delete(oid);

  // Shallow boundary: a walked commit with parents, none of them walked.
  // A previous boundary whose parents are now walked is unshallow.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const previous = new Set(args.shallow);
  for (const oid of walked.keys()) {
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = commitParentsOf(store, obj.data);
    if (!parents.length) continue;
    const hasParentInWalk = parents.some((parent) => walked.has(parent));
    if (!hasParentInWalk) shallow.push(oid);
    else if (previous.has(oid)) unshallow.push(oid);
  }
  const pack = buildPack(send.values());
  if (store.packCache.size >= PACK_CACHE_MAX) {
    const oldest = store.packCache.keys().next().value;
    if (oldest !== undefined) store.packCache.delete(oldest);
  }
  store.packCache.set(key, { pack, shallow, unshallow });
  return { shallow, unshallow, pack };
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects only — the client resolves deltas, but we never send any)
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPack(objects: Iterable<{ type: ObjType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    // Level 1: the pack only needs to inflate correctly on the client, and
    // level 1 is ~35% cheaper than the default here for ~1 KiB objects
    // (measured: 512 B blob 28 us -> 19 us, 1 KiB blob 23 us -> 16 us).
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split pack bytes into side-band-64k packets (band 1), each pkt-line <= 65520 bytes. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const max = PKT_LINE_MAX_PAYLOAD - 1; // one byte is the band number
  for (let offset = 0; offset < pack.length; offset += max) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + max));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (!out.length) out.push(pkt(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefNames(refs: RefsAccess): string[] {
  return refs.entries().map(([name]) => name).sort();
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = refsAccess(repo);
  const headTarget = `refs/heads/${defaultBranch(repo)}`;
  const headOid = refs.get(headTarget) ?? ZERO_OID;
  const caps =
    service === 'git-receive-pack'
      ? `report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:${headTarget} agent=${AGENT}`
      : `side-band-64k ofs-delta thin-pack multi_ack_detailed shallow symref=HEAD:${headTarget} agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (refs.size() === 0) {
    // Empty repo: the capabilities^{} pseudo-ref carries the capabilities.
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const name of sortedRefNames(refs)) {
      if (name === 'HEAD') continue;
      const oid = refs.get(name);
      if (!oid) continue;
      parts.push(pkt(`${oid} ${name}\n`));
      if (name.startsWith('refs/tags/')) {
        // The peeled line must follow its tag line (the client attaches it to
        // the base ref it has already seen).
        const peeled = peelToCommit(store, repo, oid);
        if (peeled && peeled !== oid) parts.push(pkt(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleInfoRefs(ctx: ReqCtx, store: Store, repo: Repo): Resp {
  const service = ctx.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  if (service === 'git-upload-pack' && wantsV2(ctx)) {
    return { status: 200, headers: { 'content-type': UPLOAD_AD }, body: v2Advertisement() };
  }
  return {
    status: 200,
    headers: { 'content-type': service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD },
    body: v0Advertisement(store, repo, service),
  };
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs + fetch
// ---------------------------------------------------------------------------------------------

function handleLsRefs(store: Store, repo: Repo, lines: readonly string[]): Resp {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') {
      // Accepted; an unborn HEAD is reported whether or not the client asks.
    } else if (line.startsWith('ref-prefix ')) {
      prefixes.push(line.slice('ref-prefix '.length));
    }
    // command= / agent= / object-format= carry no ls-refs semantics here.
  }
  const refs = refsAccess(repo);
  const headTarget = `refs/heads/${defaultBranch(repo)}`;
  const headOid = refs.get(headTarget);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  // No `version 2` line: the client's ls-refs parser treats every data packet
  // as a ref line.
  if (keep('HEAD')) {
    const suffix = symrefs ? ` symref-target:${headTarget}` : '';
    out.push(pkt(headOid ? `${headOid} HEAD${suffix}\n` : `unborn HEAD${suffix}\n`));
  }
  for (const name of sortedRefNames(refs)) {
    if (name === 'HEAD' || !keep(name)) continue;
    const oid = refs.get(name);
    if (!oid) continue;
    let text = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(store, repo, oid);
      if (peeled && peeled !== oid) text += ` peeled:${peeled}`;
    }
    out.push(pkt(`${text}\n`));
  }
  out.push(FLUSH);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: Buffer.concat(out) };
}

function handleFetchV2(store: Store, repo: Repo, lines: readonly string[]): Resp {
  const args = parseFetchArgs(lines);
  const refs = refsAccess(repo);
  const plan = computeFetch(store, repo, args, refs);
  const pack = plan.pack;
  const wanted: Array<[string, string]> = [];
  for (const want of args.wants) {
    for (const [name, oid] of refs.entries()) {
      if (oid === want && (name.startsWith('refs/heads/') || name.startsWith('refs/tags/'))) {
        wanted.push([want, name]);
      }
    }
  }
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  if (args.haves.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    const acked = args.haves.filter((have) => store.hasObject(repo, have));
    if (!acked.length) {
      parts.push(pkt('NAK\n'));
    } else {
      for (const oid of acked) parts.push(pkt(`ACK ${oid}\n`));
      parts.push(pkt('ready\n'));
    }
  }
  parts.push(DELIM);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (wanted.length) {
    parts.push(pkt('wanted-refs\n'));
    for (const [oid, name] of wanted) parts.push(pkt(`${oid} ${name}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0 fallback
// ---------------------------------------------------------------------------------------------

function handleFetchV0(store: Store, repo: Repo, packets: readonly Packet[]): Resp {
  // Two sections (wants, then haves/done), each ended by a flush. The fetch
  // arguments are the same lines in either section, so they are parsed flat.
  const args = parseFetchArgs(packetLines(packets));
  const refs = refsAccess(repo);
  const plan = computeFetch(store, repo, args, refs);
  const pack = plan.pack;
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: Buffer.concat(parts) };
}

function handleUploadPack(ctx: ReqCtx, store: Store, repo: Repo): Resp {
  const body = ctx.body ?? Buffer.alloc(0);
  if (wantsV2(ctx)) {
    const { packets } = scanPackets(body, 0, false);
    const lines = packetLines(packets);
    const first = (lines[0] ?? '').replace(/\n$/, '');
    if (first === 'command=ls-refs') return handleLsRefs(store, repo, lines);
    if (first === 'command=fetch') return handleFetchV2(store, repo, lines);
    throw new Error(`unsupported upload-pack v2 command ${JSON.stringify(first.slice(0, 40))}`);
  }
  const { packets } = scanPackets(body, 0, false);
  return handleFetchV0(store, repo, packets);
}

// ---------------------------------------------------------------------------------------------
// packfile read (receive-pack): plain objects + OFS/REF deltas
// ---------------------------------------------------------------------------------------------

/**
 * Inflate one zlib stream starting at `offset` (bounded by `limit`). The
 * reference client uses the same trick: inflateSync with {info:true} reports
 * the compressed bytes consumed via engine.bytesWritten, which is exactly
 * where the next pack entry starts.
 */
function inflateAt(buf: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, limit);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readPackVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read and fully resolve a packfile (version 2 or 3). Verifies the trailer
 * checksum first, then inflates every entry and resolves OFS/REF deltas
 * (REF bases may also live in the store — thin packs). Nothing is stored
 * here: the caller stores only after this returns without throwing, so a bad
 * pack leaves no partial objects behind.
 */
function readPack(store: Store, repo: Repo, pack: Buffer): Map<string, { type: ObjType; data: Buffer }> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const resolved = new Map<string, { type: ObjType; data: Buffer }>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const memo = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    const cached = memo.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const inPack = resolvedByOid.get(wanted);
      if (inPack) {
        const base = resolve(inPack);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        // The base may be a later pack entry: resolve entries until one yields it.
        let found: RawPackEntry | undefined;
        for (const candidate of raw) {
          if (candidate === entry) continue;
          if (resolve(candidate).oid === wanted) {
            found = candidate;
            break;
          }
        }
        if (found) {
          const base = resolve(found);
          type = base.type;
          data = applyDelta(base.data, entry.data);
        } else {
          const external = store.getObject(repo, wanted);
          if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
          type = external.type as ObjType;
          data = applyDelta(external.data, entry.data);
        }
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    memo.set(entry.offset, out);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const result = resolve(entry);
    if (!resolved.has(result.oid)) resolved.set(result.oid, { type: result.type, data: result.data });
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyPushCommand(
  store: Store,
  repo: Repo,
  refs: RefsAccess,
  cmd: PushCommand,
): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = cmd;
  if (!ref.startsWith('refs/') || ref.length > 200 || /[\s\x00-\x1f]/.test(ref)) {
    return { ref, ok: false, reason: 'invalid ref name' };
  }
  const current = refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (oldOid === ZERO_OID) return { ref, ok: false, reason: 'cannot delete an unborn ref' };
    if (current === undefined) return { ref, ok: false, reason: 'ref does not exist' };
    if (current !== oldOid) return { ref, ok: false, reason: 'old ref does not match' };
    refs.delete(ref);
    store.bumpVersion();
    return { ref, ok: true, reason: '' };
  }
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    if (!store.hasObject(repo, newOid)) return { ref, ok: false, reason: 'object not found' };
    if (ref.startsWith('refs/heads/')) {
      const obj = store.getObject(repo, newOid);
      if (!obj || obj.type !== 'commit') return { ref, ok: false, reason: 'new ref is not a commit' };
    }
    refs.set(ref, newOid);
    store.bumpVersion();
    return { ref, ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ref, ok: false, reason: 'ref does not exist' };
  if (current !== oldOid) return { ref, ok: false, reason: 'old ref does not match' };
  if (!store.hasObject(repo, newOid)) return { ref, ok: false, reason: 'object not found' };
  if (ref.startsWith('refs/heads/')) {
    const obj = store.getObject(repo, newOid);
    if (!obj || obj.type !== 'commit') return { ref, ok: false, reason: 'new ref is not a commit' };
  }
  if (oldOid === newOid) return { ref, ok: true, reason: '' };
  let fastForward = false;
  try {
    fastForward = store.isFastForward(repo, oldOid, newOid);
  } catch {
    fastForward = false;
  }
  if (!fastForward) return { ref, ok: false, reason: 'non-fast-forward' };
  refs.set(ref, newOid);
  store.bumpVersion();
  return { ref, ok: true, reason: '' };
}

function handleReceivePack(ctx: ReqCtx, store: Store, repo: Repo): Resp {
  const body = ctx.body ?? Buffer.alloc(0);
  const { packets, end } = scanPackets(body, 0, true);
  const lines = packetLines(packets);
  if (!lines.length) throw new Error('receive-pack command list is empty');
  const commands: PushCommand[] = [];
  let sideband = false;
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ').filter(Boolean);
        sideband = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) ([^ \t\r\n]+)$/.exec(line);
    if (!match) throw new Error(`malformed receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }

  const packBytes = body.subarray(end);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  if (needsPack) {
    if (!packBytes.length) {
      unpackOk = false;
    } else {
      try {
        const objects = readPack(store, repo, packBytes);
        for (const [oid, object] of objects) {
          // readPack already verified each object's SHA-1 while resolving
          // the pack; re-hashing here would pay the same hash twice.
          store.putObjectKnownSha(repo, object.type, object.data, oid);
        }
      } catch {
        unpackOk = false;
      }
    }
  }

  const refs = refsAccess(repo);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    // A refused unpack still gets a report: every ref is ng, nothing moves.
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const command of commands) results.push(applyPushCommand(store, repo, refs, command));
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'unpacker error'}`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pkt(`${line}\n`)), FLUSH]);
  let responseBody: Buffer;
  if (sideband) {
    // The report-status stream is itself pkt-lined inside band 1.
    const chunks: Buffer[] = [];
    const max = PKT_LINE_MAX_PAYLOAD - 1;
    for (let offset = 0; offset < report.length; offset += max) {
      chunks.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + max))])));
    }
    responseBody = Buffer.concat([...chunks, FLUSH]);
  } else {
    responseBody = report;
  }
  return { status: 200, headers: { 'content-type': RECEIVE_RESULT }, body: responseBody };
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function handleGit(ctx: ReqCtx, store: Store): Resp | null {
  try {
    const path = (ctx.path ?? '').split('?')[0];
    const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (!match) return null;
    const owner = safeDecode(match[1]);
    const repoName = safeDecode(match[2]);
    const rest = match[3] ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) {
      return null;
    }
    const repo = lookupRepo(store, owner, repoName);
    if (!repo) return notFound();
    if (ctx.method === 'GET' && rest === '/info/refs') return handleInfoRefs(ctx, store, repo);
    if (ctx.method === 'POST' && rest === '/git-upload-pack') return handleUploadPack(ctx, store, repo);
    if (ctx.method === 'POST' && rest === '/git-receive-pack') return handleReceivePack(ctx, store, repo);
    return null;
  } catch (err) {
    // Malformed input must never take the server down: answer 400 and stay up.
    return jsonResp(400, { message: err instanceof Error ? err.message : 'bad request' });
  }
}
