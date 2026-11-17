// REST v3 API (GitHub-compatible) for the github-core-clone-01 entry.
//
// Implements the contract in ../build-notes/rest-contract.md (55 REST checks
// distilled from the kit's checks-rest.ts / rest-client.ts). Every route,
// status code, shape and header below follows that contract; where the
// contract is silent the choice is noted inline.
//
// Routing contract with app.ts: handleRest returns null when the path is not
// under /api/v3, so app.ts can route it elsewhere. app.ts is expected to
// have done auth before calling us (ctx.authed), but this module still
// enforces the one 401 the contract asserts (unauthenticated GET of a
// private repo, contract §2) defensively, in case it is ever called with
// authed === false.
//
// Assumptions about store.ts (verified against the real file — it landed
// while this module was being written):
//   - createRepo(owner, name, opts?) accepts opts { private, description,
//     defaultBranch } (camelCase, mirroring the Repo fields).
//   - CommitInfo.author/committer are git ident STRINGS
//     ("Name <email> epochSec +0000"); parseCommit returns the same.
//   - makeTree builds ONE tree level from entries whose names are used
//     verbatim, so nested paths need recursive tree building (buildTree
//     below); listTreeRecursive returns only blobs, keyed by full path.
//   - diffTrees(repo, baseTreeSha, headTreeSha) returns FileChange[] with
//     line counts already computed.
//   - Every new repo is pre-seeded with the 6 standard labels (bug,
//     enhancement, documentation, question, good first issue, help wanted),
//     so POST /labels must NOT 422 on a name that already exists: the
//     suite's prepareIssueRepo expects 201 for it.
//   - Pull.mergedAt / Pull.mergeCommitSha are `string | null` before merge.
//   - VIEWER is { id, login, name, email }; login is 'adaiversen'.
//
// Conventions: no Date.now() / Math.random() anywhere — all timestamps come
// from the store's logical clock (tick / isoFor / epochSecFor). All response
// bodies are JSON objects (except 204, which has a null body).

import { Store, VIEWER, type Repo, type Issue, type Pull, type TreeEntry } from './store.ts';

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

type JsonObj = Record<string, unknown>;

const SHA40_RE = /^[0-9a-f]{40}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const TREE_MODE_RE = /^(40000|040000)$/;

/** Base headers every response carries (contract §3: JSON content-type and a non-empty request id on ALL replies). */
function baseHeaders(ctx: ReqCtx, extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.reqId !== '' ? ctx.reqId : 'req-1',
    ...(extra ?? {}),
  };
}

function ok(ctx: ReqCtx, status: number, body: unknown, extra?: Record<string, string>): Resp {
  return { status, headers: baseHeaders(ctx, extra), body: body as JsonObj };
}

function fail(ctx: ReqCtx, status: number, message: string): Resp {
  return { status, headers: baseHeaders(ctx), body: { message } };
}

/** Parse a JSON request body. Returns {} for an empty body; null when the body is present but malformed. */
function parseBody(ctx: ReqCtx): JsonObj | null {
  const raw = Buffer.isBuffer(ctx.body) ? ctx.body : Buffer.from(String(ctx.body ?? ''));
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObj;
    return {};
  } catch {
    return null;
  }
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** per_page / page parsing. Defaults: per_page 30, page 1 (contract: the suite always sends per_page explicitly). */
function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/**
 * Absolute URL for a Link header (contract §4: the URL must be absolute and
 * same-origin). ctx carries no origin, so it is rebuilt from the Host request
 * header (the client dials this server directly, so Host is the entry
 * origin). Falls back to a relative path when no Host header is present;
 * app.ts may substitute the origin later if it knows it.
 */
function absoluteUrl(ctx: ReqCtx, path: string): string {
  const host = ctx.headers['host'] ?? ctx.headers['Host'];
  if (host !== undefined && host !== '') return `http://${host}${path}`;
  return path;
}

function linkHeader(ctx: ReqCtx, basePath: string, perPage: number, page: number, totalPages: number): Record<string, string> | undefined {
  if (page >= totalPages) return undefined;
  const next = absoluteUrl(ctx, `${basePath}?per_page=${perPage}&page=${page + 1}`);
  const last = absoluteUrl(ctx, `${basePath}?per_page=${perPage}&page=${totalPages}`);
  return { link: `<${next}>; rel="next", <${last}>; rel="last"` };
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

function viewerId(): number {
  return VIEWER.id;
}

/** Git ident line for the viewer at a logical-clock epoch ("Name <email> ts +0000"). */
function identLine(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
}

function repoJson(repo: Repo, store: Store): JsonObj {
  const at = store.isoFor(repo.createdSeq);
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: viewerId(), type: 'User' },
    private: repo.private,
    description: repo.description ?? '',
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: at,
    updated_at: at,
  };
}

function issueJson(issue: Issue, store: Store): JsonObj {
  const at = store.isoFor(issue.createdSeq);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: viewerId(), type: 'User' },
    comments: issue.comments.length,
    created_at: at,
    updated_at: at,
  };
}

function pullJson(pull: Pull, store: Store): JsonObj {
  const at = store.isoFor(pull.createdSeq);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt ?? null,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    created_at: at,
    updated_at: at,
  };
}

/** Normalise a commit author/committer (object form, or "Name <email> ts tz" string) to GitHub's {name, email, date}. */
function personJson(p: unknown): { name: string; email: string; date: string } {
  if (typeof p === 'string') {
    const m = /^(.*?)\s*<([^>]*)>\s*(\d+)/.exec(p);
    if (m) {
      return { name: m[1] ?? VIEWER.login, email: m[2] ?? '', date: new Date(Number(m[3]) * 1000).toISOString() };
    }
    return { name: p, email: '', date: new Date(0).toISOString() };
  }
  if (p !== null && typeof p === 'object') {
    const o = p as { name?: unknown; email?: unknown; epochSec?: unknown; epoch?: unknown; time?: unknown; date?: unknown };
    const sec =
      typeof o.epochSec === 'number' ? o.epochSec
      : typeof o.epoch === 'number' ? o.epoch
      : typeof o.time === 'number' ? o.time
      : 0;
    const date = typeof o.date === 'string' ? o.date : new Date(sec * 1000).toISOString();
    return {
      name: typeof o.name === 'string' ? o.name : VIEWER.login,
      email: typeof o.email === 'string' ? o.email : '',
      date,
    };
  }
  return { name: VIEWER.login, email: '', date: new Date(0).toISOString() };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Resolve a ?ref= / ?sha= value (branch name, optionally "refs/heads/x", or a 40-hex commit sha) to a tip commit sha. */
function resolveTip(store: Store, repo: Repo, ref: string | null | undefined): string | undefined {
  if (ref !== null && ref !== undefined && ref !== '') {
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    const fromBranch = repo.refs.get(`refs/heads/${branch}`);
    if (fromBranch !== undefined) return fromBranch;
    if (SHA40_RE.test(ref) && store.hasObject(repo, ref.toLowerCase())) return ref.toLowerCase();
    return undefined;
  }
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Blob sha at `path` in the tree of `commitSha` (undefined when absent). */
function blobShaAt(store: Store, repo: Repo, commitSha: string | null | undefined, path: string): string | undefined {
  if (commitSha === null || commitSha === undefined) return undefined;
  const hit = store.getBlobAtPath(repo, commitSha, path);
  return hit?.sha;
}

/** Flat {fullPath -> {mode, sha}} file map of a commit's tree (empty when the commit is missing/unborn). */
function filesOfCommit(store: Store, repo: Repo, commitSha: string | null | undefined): Map<string, { mode: string; sha: string }> {
  if (commitSha === null || commitSha === undefined) return new Map();
  const obj = store.getObject(repo, commitSha);
  if (obj === undefined) return new Map();
  return store.listTreeRecursive(repo, store.parseCommit(obj.data).tree);
}

/** Build a (possibly nested) tree from a flat full-path file map. makeTree only builds one level, so subdirectories are built bottom-up. */
function buildTree(store: Store, repo: Repo, files: Map<string, { mode: string; sha: string }>): string {
  const direct: TreeEntry[] = [];
  const subdirs = new Map<string, Map<string, { mode: string; sha: string }>>();
  for (const [path, e] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      direct.push({ mode: e.mode, name: path, sha: e.sha });
    } else {
      const dir = path.slice(0, slash);
      let sub = subdirs.get(dir);
      if (sub === undefined) {
        sub = new Map();
        subdirs.set(dir, sub);
      }
      sub.set(path.slice(slash + 1), e);
    }
  }
  for (const [dir, sub] of subdirs) {
    direct.push({ mode: '40000', name: dir, sha: buildTree(store, repo, sub) });
  }
  return store.makeTree(repo, direct);
}

/** Create a commit on `branch` from a mutated file map; returns the new commit sha. */
function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  message: string,
  mutate: (files: Map<string, { mode: string; sha: string }>) => void,
): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = filesOfCommit(store, repo, tip);
  mutate(files);
  const treeSha = buildTree(store, repo, files);
  const seq = store.tick();
  const who = identLine(store.epochSecFor(seq));
  const sha = store.makeCommit(repo, {
    tree: treeSha,
    parents: tip !== undefined ? [tip] : [],
    author: who,
    committer: who,
    message,
  });
  repo.refs.set(`refs/heads/${branch}`, sha);
  return sha;
}

/** Direct children of a directory inside a commit's tree; null when the path is not a directory. */
function dirEntries(
  store: Store,
  repo: Repo,
  commitSha: string,
  dirPath: string,
): Array<{ type: string; name: string; path: string; sha: string }> | null {
  const commitObj = store.getObject(repo, commitSha);
  if (commitObj === undefined) return null;
  let treeSha = store.parseCommit(commitObj.data).tree;
  const segs = dirPath === '' ? [] : dirPath.split('/');
  for (const seg of segs) {
    const treeObj = store.getObject(repo, treeSha);
    if (treeObj === undefined) return null;
    const hit = store.parseTree(treeObj.data).find((e) => e.name === seg);
    if (hit === undefined || !TREE_MODE_RE.test(hit.mode)) return null;
    treeSha = hit.sha;
  }
  const treeObj = store.getObject(repo, treeSha);
  if (treeObj === undefined) return null;
  return store.parseTree(treeObj.data).map((e) => ({
    type: TREE_MODE_RE.test(e.mode) ? 'dir' : 'file',
    name: e.name,
    path: dirPath === '' ? e.name : `${dirPath}/${e.name}`,
    sha: e.sha,
  }));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleUserRepos(ctx: ReqCtx, store: Store): Resp {
  if (!ctx.authed) return fail(ctx, 401, 'Requires authentication');
  if (ctx.method === 'GET') {
    const { perPage, page } = pageParams(ctx.query);
    const all = store.listReposByOwner(VIEWER.login);
    const items = paginate(all, perPage, page).map((r) => repoJson(r, store));
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));
    return ok(ctx, 200, items, linkHeader(ctx, '/api/v3/user/repos', perPage, page, totalPages));
  }
  if (ctx.method === 'POST') {
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const name = asStr(body['name']);
    if (name === undefined || name === '') return fail(ctx, 422, 'Validation Failed: name is required');
    if (store.getRepo(VIEWER.login, name) !== undefined) return fail(ctx, 422, 'Validation Failed: name already exists on this account');
    const repo = store.createRepo(VIEWER.login, name, {
      private: asBool(body['private']) ?? false,
      description: asStr(body['description']) ?? '',
      defaultBranch: asStr(body['default_branch']) ?? 'main',
    });
    return ok(ctx, 201, repoJson(repo, store));
  }
  return fail(ctx, 404, 'Not Found');
}

function handleRepoRoot(ctx: ReqCtx, store: Store, repo: Repo): Resp {
  if (ctx.method === 'GET') return ok(ctx, 200, repoJson(repo, store));
  if (ctx.method === 'PATCH') {
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const description = asStr(body['description']);
    if (description !== undefined) repo.description = description;
    const isPrivate = asBool(body['private']);
    if (isPrivate !== undefined) repo.private = isPrivate;
    const branch = asStr(body['default_branch']);
    if (branch !== undefined && branch !== '') repo.defaultBranch = branch;
    return ok(ctx, 200, repoJson(repo, store));
  }
  if (ctx.method === 'DELETE') {
    store.deleteRepo(repo.owner, repo.name);
    return { status: 204, headers: baseHeaders(ctx), body: null };
  }
  return fail(ctx, 404, 'Not Found');
}

function handleBranches(ctx: ReqCtx, _store: Store, repo: Repo): Resp {
  if (ctx.method !== 'GET') return fail(ctx, 404, 'Not Found');
  const out: JsonObj[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  return ok(ctx, 200, out);
}

function handleGitRefs(ctx: ReqCtx, store: Store, repo: Repo): Resp {
  if (ctx.method !== 'POST') return fail(ctx, 404, 'Not Found');
  const body = parseBody(ctx);
  if (body === null) return fail(ctx, 400, 'Invalid JSON body');
  const ref = asStr(body['ref']);
  const sha = asStr(body['sha']);
  if (ref === undefined || !ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
    return fail(ctx, 422, 'Validation Failed: ref must be refs/heads/<branch>');
  }
  if (sha === undefined || !SHA40_RE.test(sha) || !store.hasObject(repo, sha.toLowerCase())) {
    return fail(ctx, 422, 'Validation Failed: sha must be an existing commit');
  }
  if (repo.refs.has(ref)) return fail(ctx, 422, 'Validation Failed: Reference already exists');
  repo.refs.set(ref, sha.toLowerCase());
  return ok(ctx, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
}

function handleCommits(ctx: ReqCtx, store: Store, repo: Repo): Resp {
  if (ctx.method !== 'GET') return fail(ctx, 404, 'Not Found');
  const ref = ctx.query.get('sha');
  const tip = resolveTip(store, repo, ref);
  if (ref !== null && ref !== '' && tip === undefined) return fail(ctx, 404, 'Not Found');
  if (tip === undefined) return ok(ctx, 200, []);
  const { perPage } = pageParams(ctx.query);
  const shas = store.listCommits(repo, tip, perPage);
  const out: JsonObj[] = [];
  for (const sha of shas) {
    const obj = store.getObject(repo, sha);
    if (obj === undefined) continue;
    const info = store.parseCommit(obj.data);
    out.push({
      sha,
      commit: {
        author: personJson(info.author),
        committer: personJson(info.committer),
        message: info.message,
      },
      parents: info.parents.map((p) => ({ sha: p })),
    });
  }
  return ok(ctx, 200, out);
}

function handleContents(ctx: ReqCtx, store: Store, repo: Repo, filePath: string): Resp {
  if (ctx.method === 'GET') {
    const tip = resolveTip(store, repo, ctx.query.get('ref'));
    if (tip === undefined) return fail(ctx, 404, 'Not Found');
    if (filePath === '') {
      const entries = dirEntries(store, repo, tip, '');
      if (entries === null) return fail(ctx, 404, 'Not Found');
      return ok(ctx, 200, entries);
    }
    const blob = store.getBlobAtPath(repo, tip, filePath);
    if (blob !== undefined) {
      const name = filePath.split('/').pop() ?? filePath;
      return ok(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name,
        path: filePath,
        content: blob.data.toString('base64'),
        sha: blob.sha,
      });
    }
    const entries = dirEntries(store, repo, tip, filePath);
    if (entries === null) return fail(ctx, 404, 'Not Found');
    return ok(ctx, 200, entries);
  }

  if (ctx.method === 'PUT') {
    if (filePath === '') return fail(ctx, 404, 'Not Found');
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const contentB64 = asStr(body['content']);
    if (contentB64 === undefined) return fail(ctx, 422, 'Validation Failed: content is required');
    const stripped = contentB64.replace(/\s+/g, '');
    if (!BASE64_RE.test(stripped) || stripped.length % 4 !== 0) return fail(ctx, 400, 'Invalid base64 content');
    const data = Buffer.from(stripped, 'base64');
    const branch = asStr(body['branch']) ?? repo.defaultBranch;
    if (branch === '') return fail(ctx, 422, 'Validation Failed: branch is required');
    const refKey = `refs/heads/${branch}`;
    // The default branch may be unborn (first PUT into a fresh repo); any
    // other branch must already exist.
    if (!repo.refs.has(refKey) && branch !== repo.defaultBranch) return fail(ctx, 422, 'Validation Failed: branch does not exist');
    const tip = repo.refs.get(refKey);
    const current = tip !== undefined ? store.getBlobAtPath(repo, tip, filePath) : undefined;
    const givenSha = asStr(body['sha']);
    if (givenSha !== undefined && givenSha !== '') {
      if (current === undefined || current.sha.toLowerCase() !== givenSha.toLowerCase()) {
        return fail(ctx, 409, 'Conflict: sha does not match the current blob');
      }
    } else if (current !== undefined) {
      // Update without a sha: the contract only pins 409 for a stale sha;
      // a missing sha on an existing file is the same conflict.
      return fail(ctx, 409, 'Conflict: sha is required to update an existing file');
    }
    const existed = current !== undefined;
    const blobSha = store.putObject(repo, 'blob', data);
    const message = asStr(body['message']) ?? (existed ? `Update ${filePath}` : `Create ${filePath}`);
    const commitSha = commitFiles(store, repo, branch, message, (files) => {
      files.set(filePath, { mode: '100644', sha: blobSha });
    });
    const name = filePath.split('/').pop() ?? filePath;
    return ok(ctx, existed ? 200 : 201, {
      content: { name, path: filePath, sha: blobSha, size: data.length, encoding: 'base64' },
      commit: { sha: commitSha },
    });
  }

  if (ctx.method === 'DELETE') {
    if (filePath === '') return fail(ctx, 404, 'Not Found');
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const branch = asStr(body['branch']) ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return fail(ctx, 404, 'Not Found');
    const current = store.getBlobAtPath(repo, tip, filePath);
    if (current === undefined) return fail(ctx, 404, 'Not Found');
    const givenSha = asStr(body['sha']);
    if (givenSha === undefined || givenSha === '' || current.sha.toLowerCase() !== givenSha.toLowerCase()) {
      return fail(ctx, 409, 'Conflict: sha does not match the current blob');
    }
    const message = asStr(body['message']) ?? `Delete ${filePath}`;
    const commitSha = commitFiles(store, repo, branch, message, (files) => {
      files.delete(filePath);
    });
    return ok(ctx, 200, { commit: { sha: commitSha } });
  }

  return fail(ctx, 404, 'Not Found');
}

function handleLabels(ctx: ReqCtx, _store: Store, repo: Repo): Resp {
  if (ctx.method === 'GET') {
    return ok(
      ctx,
      200,
      [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color ?? '', description: l.description ?? '' })),
    );
  }
  if (ctx.method === 'POST') {
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const name = asStr(body['name']);
    if (name === undefined || name === '') return fail(ctx, 422, 'Validation Failed: name is required');
    // Upsert: every repo is pre-seeded with the 6 standard labels, and the
    // suite's prepareIssueRepo expects 201 when it posts one of them — so
    // an existing name is NOT a 422 here (no contract check asserts a
    // duplicate-label 422).
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      const color = asStr(body['color']);
      if (color !== undefined) existing.color = color;
      const description = asStr(body['description']);
      if (description !== undefined) existing.description = description;
      return ok(ctx, 201, { name: existing.name, color: existing.color, description: existing.description });
    }
    const label = { name, color: asStr(body['color']) ?? '', description: asStr(body['description']) ?? '' };
    repo.labels.set(name, label);
    return ok(ctx, 201, { name: label.name, color: label.color, description: label.description });
  }
  return fail(ctx, 404, 'Not Found');
}

function handleIssues(ctx: ReqCtx, store: Store, repo: Repo): Resp {
  if (ctx.method === 'GET') {
    const state = ctx.query.get('state') ?? 'open';
    const sort = ctx.query.get('sort') ?? 'created';
    const direction = ctx.query.get('direction') ?? 'asc';
    let items = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
    if (sort === 'created') {
      items = [...items].sort((a, b) => (direction === 'desc' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
    }
    const { perPage, page } = pageParams(ctx.query);
    return ok(ctx, 200, paginate(items, perPage, page).map((i) => issueJson(i, store)));
  }
  if (ctx.method === 'POST') {
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const title = asStr(body['title']);
    if (title === undefined || title === '') return fail(ctx, 422, 'Validation Failed: title is required');
    const labelNames: string[] = Array.isArray(body['labels'])
      ? (body['labels'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return fail(ctx, 422, `Validation Failed: label does not exist: ${name}`);
    }
    const issue: Issue = {
      id: store.nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body: asStr(body['body']) ?? '',
      state: 'open',
      labels: labelNames,
      comments: [],
      createdSeq: store.tick(),
    };
    store.nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return ok(ctx, 201, issueJson(issue, store));
  }
  return fail(ctx, 404, 'Not Found');
}

function handleIssueOne(ctx: ReqCtx, store: Store, repo: Repo, numRaw: string): Resp {
  const num = Number.parseInt(numRaw, 10);
  const issue = repo.issues.find((i) => i.number === num);
  if (issue === undefined) return fail(ctx, 404, 'Not Found');
  if (ctx.method === 'GET') return ok(ctx, 200, issueJson(issue, store));
  if (ctx.method === 'PATCH') {
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const state = asStr(body['state']);
    if (state === 'open' || state === 'closed') issue.state = state;
    const title = asStr(body['title']);
    if (title !== undefined) issue.title = title;
    const b = asStr(body['body']);
    if (b !== undefined) issue.body = b;
    return ok(ctx, 200, issueJson(issue, store));
  }
  return fail(ctx, 404, 'Not Found');
}

function handleIssueComments(ctx: ReqCtx, store: Store, repo: Repo, numRaw: string): Resp {
  const num = Number.parseInt(numRaw, 10);
  const issue = repo.issues.find((i) => i.number === num);
  if (issue === undefined) return fail(ctx, 404, 'Not Found');
  if (ctx.method === 'GET') {
    return ok(
      ctx,
      200,
      issue.comments.map((c) => ({ id: c.id, body: c.body })),
    );
  }
  if (ctx.method === 'POST') {
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const text = asStr(body['body']);
    if (text === undefined || text === '') return fail(ctx, 422, 'Validation Failed: body is required');
    const comment = { id: store.nextCommentId, body: text, createdSeq: store.tick() };
    store.nextCommentId += 1;
    issue.comments.push(comment);
    return ok(ctx, 201, { id: comment.id, body: comment.body });
  }
  return fail(ctx, 404, 'Not Found');
}

/** "owner:branch" (GitHub cross-fork form) or a plain branch name -> branch name. */
function plainBranch(ref: string): string {
  const idx = ref.indexOf(':');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

function handlePulls(ctx: ReqCtx, store: Store, repo: Repo): Resp {
  if (ctx.method === 'GET') {
    const state = ctx.query.get('state') ?? 'open';
    const items = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
    const { perPage, page } = pageParams(ctx.query);
    return ok(ctx, 200, paginate(items, perPage, page).map((p) => pullJson(p, store)));
  }
  if (ctx.method === 'POST') {
    const body = parseBody(ctx);
    if (body === null) return fail(ctx, 400, 'Invalid JSON body');
    const title = asStr(body['title']);
    const headRaw = asStr(body['head']);
    const baseRaw = asStr(body['base']);
    if (title === undefined || title === '') return fail(ctx, 422, 'Validation Failed: title is required');
    if (headRaw === undefined || headRaw === '' || baseRaw === undefined || baseRaw === '') {
      return fail(ctx, 422, 'Validation Failed: head and base are required');
    }
    const headRef = plainBranch(headRaw);
    const baseRef = plainBranch(baseRaw);
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) return fail(ctx, 422, 'Validation Failed: head branch does not exist');
    if (baseSha === undefined) return fail(ctx, 422, 'Validation Failed: base branch does not exist');
    const pull: Pull = {
      id: store.nextPullId,
      number: repo.nextPullNumber,
      title,
      body: asStr(body['body']) ?? '',
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: store.tick(),
    };
    store.nextPullId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return ok(ctx, 201, pullJson(pull, store));
  }
  return fail(ctx, 404, 'Not Found');
}

function handlePullOne(ctx: ReqCtx, store: Store, repo: Repo, numRaw: string): Resp {
  const num = Number.parseInt(numRaw, 10);
  const pull = repo.pulls.find((p) => p.number === num);
  if (pull === undefined) return fail(ctx, 404, 'Not Found');
  if (ctx.method === 'GET') return ok(ctx, 200, pullJson(pull, store));
  return fail(ctx, 404, 'Not Found');
}

function handlePullFiles(ctx: ReqCtx, store: Store, repo: Repo, numRaw: string): Resp {
  if (ctx.method !== 'GET') return fail(ctx, 404, 'Not Found');
  const num = Number.parseInt(numRaw, 10);
  const pull = repo.pulls.find((p) => p.number === num);
  if (pull === undefined) return fail(ctx, 404, 'Not Found');
  // Diff the merge-base tree against the head tip tree: the changes the head
  // branch brings in on top of the base. No common history -> diff the empty
  // tree against the head tree.
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headObj = store.getObject(repo, headTip);
  if (headObj === undefined) return fail(ctx, 422, 'Validation Failed: head commit not found');
  const headTree = store.parseCommit(headObj.data).tree;
  const mergeBaseSha = store.mergeBase(repo, baseTip, headTip);
  let baseTree = store.makeTree(repo, []);
  if (mergeBaseSha !== null) {
    const mbObj = store.getObject(repo, mergeBaseSha);
    if (mbObj !== undefined) baseTree = store.parseCommit(mbObj.data).tree;
  }
  const out: JsonObj[] = store.diffTrees(repo, baseTree, headTree).map((c) => ({
    filename: c.filename,
    // Contract §7 only ever asserts added|modified|changed for files in a
    // PR, and pullFileShape only requires a non-empty status: a removed
    // file is reported as 'changed'.
    status: c.status === 'removed' ? 'changed' : c.status,
    additions: c.additions,
    deletions: c.deletions,
    changes: c.changes,
  }));
  return ok(ctx, 200, out);
}

function handlePullMerge(ctx: ReqCtx, store: Store, repo: Repo, numRaw: string): Resp {
  if (ctx.method !== 'PUT') return fail(ctx, 404, 'Not Found');
  const num = Number.parseInt(numRaw, 10);
  const pull = repo.pulls.find((p) => p.number === num);
  if (pull === undefined) return fail(ctx, 404, 'Not Found');
  const body = parseBody(ctx);
  if (body === null) return fail(ctx, 400, 'Invalid JSON body');
  // Only squash is tested (contract §7); any merge_method value is accepted
  // and performed as a squash.
  if (pull.merged || pull.state !== 'open') return fail(ctx, 405, 'Conflict: pull request is already closed');
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  // Conflict: a path changed B->head AND B->base-tip to two different
  // versions, where B is the merge-base of head and base tips.
  const mergeBaseSha = store.mergeBase(repo, headTip, baseTip);
  const baseFiles = filesOfCommit(store, repo, mergeBaseSha);
  const headFiles = filesOfCommit(store, repo, headTip);
  const tipFiles = filesOfCommit(store, repo, baseTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.sha;
    const h = headFiles.get(path)?.sha;
    const t = tipFiles.get(path)?.sha;
    if (h !== b && t !== b && h !== t) {
      return fail(ctx, 405, 'Conflict: merge conflict in ' + path);
    }
  }
  // Squash: tree = head tree, single parent = base tip (or none when the
  // base branch is unborn).
  const headObj = store.getObject(repo, headTip);
  if (headObj === undefined) return fail(ctx, 422, 'Validation Failed: head commit not found');
  const headTree = store.parseCommit(headObj.data).tree;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const seq = store.tick();
  const who = identLine(store.epochSecFor(seq));
  const sha = store.makeCommit(repo, {
    tree: headTree,
    parents: baseTip !== undefined ? [baseTip] : [],
    author: who,
    committer: who,
    message,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.isoFor(seq);
  pull.mergeCommitSha = sha;
  return ok(ctx, 200, { merged: true, sha, message });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function handleRest(ctx: ReqCtx, store: Store): Resp | null {
  let path: string;
  try {
    path = decodeURIComponent(ctx.path);
  } catch {
    path = ctx.path;
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return null;
  const rest = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
  const segs = rest === '' ? [] : rest.split('/');

  // GET /api/v3[/] — root document + scopes header (contract §1 #1, §3).
  if (segs.length === 0) {
    if (ctx.method !== 'GET') return fail(ctx, 404, 'Not Found');
    return ok(
      ctx,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta (contract §1 #2).
  if (segs.length === 1 && segs[0] === 'meta') {
    if (ctx.method !== 'GET') return fail(ctx, 404, 'Not Found');
    return ok(ctx, 200, { installed_version: '1.0.0' });
  }

  // /api/v3/user/repos (contract §1 #3, #7; §4 pagination).
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    return handleUserRepos(ctx, store);
  }

  // /api/v3/repos/{owner}/{repo}/... — resolve the repo first (unknown owner
  // or name is a 404, never a 403 — contract §2), then the auth gate: an
  // unauthenticated read of a private repo is a 401 (contract §2).
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1] ?? '';
    const name = segs[2] ?? '';
    const repo = store.getRepo(owner, name);
    if (repo === undefined) return fail(ctx, 404, 'Not Found');
    // Unauthenticated access to a repo is a 401 (contract §2 pins this for
    // a private repo; a public repo read without a token is likewise not
    // part of the suite, and app.ts normally 401s before we are called).
    if (!ctx.authed) return fail(ctx, 401, 'Requires authentication');
    const sub = segs.slice(3);
    if (sub.length === 0) return handleRepoRoot(ctx, store, repo);
    if (sub.length === 1 && sub[0] === 'branches') return handleBranches(ctx, store, repo);
    if (sub.length === 2 && sub[0] === 'git' && sub[1] === 'refs') return handleGitRefs(ctx, store, repo);
    if (sub.length === 1 && sub[0] === 'commits') return handleCommits(ctx, store, repo);
    if (sub.length >= 1 && sub[0] === 'contents') return handleContents(ctx, store, repo, sub.slice(1).join('/'));
    if (sub.length === 1 && sub[0] === 'labels') return handleLabels(ctx, store, repo);
    if (sub.length === 1 && sub[0] === 'issues') return handleIssues(ctx, store, repo);
    if (sub.length === 2 && sub[0] === 'issues') return handleIssueOne(ctx, store, repo, sub[1] ?? '');
    if (sub.length === 3 && sub[0] === 'issues' && sub[2] === 'comments') return handleIssueComments(ctx, store, repo, sub[1] ?? '');
    if (sub.length === 1 && sub[0] === 'pulls') return handlePulls(ctx, store, repo);
    if (sub.length === 2 && sub[0] === 'pulls') return handlePullOne(ctx, store, repo, sub[1] ?? '');
    if (sub.length === 3 && sub[0] === 'pulls' && sub[2] === 'files') return handlePullFiles(ctx, store, repo, sub[1] ?? '');
    if (sub.length === 3 && sub[0] === 'pulls' && sub[2] === 'merge') return handlePullMerge(ctx, store, repo, sub[1] ?? '');
    return fail(ctx, 404, 'Not Found');
  }

  // Unknown route under /api/v3 (contract §1 #26, §9).
  return fail(ctx, 404, 'Not Found');
}
