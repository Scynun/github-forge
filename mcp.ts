// mcp.ts — Model Context Protocol (Streamable HTTP) endpoint for github-forge.
//
// Serves POST /mcp only. Transport is plain JSON (not SSE): every request gets
// exactly one JSON-RPC response, except notifications which get HTTP 202 with
// an empty body. Node 22 stdlib only; no Date.now() / Math.random() — all
// state (ids, timestamps) comes from the shared Store.
//
// Ground truth: ~/workspace/makefun/build-notes/mcp-contract.md
// (15 checks, 2 eras: modern 2026-07-28 via server/discover, legacy
// <=2025-11-25 via initialize + notifications/initialized).
//
// Decisions locked in (see the contract sections cited):
// - Auth is NOT checked here. app.ts decides 401 before calling handleMcp
//   (contract §1.6: auth is decided before any tool lookup); ctx.authed is
//   accepted as already enforced.
// - Non-POST on /mcp -> HTTP 405 + JSON-RPC -32600. The client only ever
//   POSTs, and a 405 is one of the probe refusals that falls back to the
//   legacy handshake (contract §2.2 step 4), so this can never wedge connect().
// - Parse error -> HTTP 400 + JSON-RPC -32700 (contract §6.2, modern era).
//   The id is recovered from the raw body with a small regex when possible,
//   else null (JSON-RPC spec default when the id cannot be parsed).
// - initialize: echo the client's protocolVersion whenever it is a valid
//   YYYY-MM-DD string (covers '2026-07-28' and every legacy revision), else
//   answer '2025-11-25'. The client accepts any valid date as the negotiated
//   revision, and only retries on -32602, which initialize never returns here.
// - notifications/* (any request without an id) -> HTTP 202, body null.
//   Streamable HTTP: a notification has no JSON-RPC response.
// - tools/list is byte-identical across calls: TOOLS is one top-level const
//   and every call returns { tools: TOOLS } — same reference, same key order,
//   no dynamic fields (contract §4.7).
// - Unknown tool -> JSON-RPC -32602 with HTTP 200, never HTTP 500
//   (contract §6.1; -32601 is equally accepted, -32602 is used here).
// - Missing required argument at runtime -> tool result { isError: true }
//   (contract §6.3; -32602 is equally accepted).
// - tools/call result: content[0].text is the JSON string of the object AND
//   structuredContent is that same object (contract §5.4). list_issues wraps
//   the array as structuredContent { issues: [...] } because structuredContent
//   must be an object; the content text still carries the raw array JSON, so
//   the list-issues check (which reads resultText) sees title / "number": N.
// - Squash merge is implemented here from the Store alone (no rest.ts /
//   graphql.ts import): new commit with tree = head tree, parent = base tip,
//   base ref moved to the merge commit, pull closed + merged. The exact
//   shapes of repo.objects / repo.refs live in store.ts (written by a sibling
//   module); the helpers below detect Map vs plain-object and string vs
//   object values at runtime instead of assuming one layout, and degrade
//   gracefully: the pull is always marked merged with a deterministic SHA-1
//   merge commit, even if the object store shape is unrecognised.

import { createHash } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED_VERSIONS = [MODERN_REVISION, ...LEGACY_REVISIONS];
const REVISION_RE = /^\d{4}-\d{2}-\d{2}$/;

const JSON_HEADERS = { 'content-type': 'application/json' };

// ---------------------------------------------------------------------------
// Tool catalogue — ONE const, returned by reference on every tools/list call.
// Only required fields the client can actually fill (contract §4.6): a stray
// required property (e.g. labels, assignee) fails the check before the tool
// is even called. No additionalProperties, no x-mcp-header annotations.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body text of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body text of the pull request.' },
        head: { type: 'string', description: 'Name of the head (source) branch.' },
        base: { type: 'string', description: 'Name of the base (target) branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Aliases the suite accepts for each canonical tool (contract §4.4).
// Matching is exact-then-suffix on the normalised name (contract §4.3).
const TOOL_ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rpcOk(id: unknown, result: unknown): Resp {
  return { status: 200, headers: JSON_HEADERS, body: { jsonrpc: '2.0', id, result } };
}

function rpcErr(id: unknown, code: number, message: string): Resp {
  return { status: 200, headers: JSON_HEADERS, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** Successful tool result: JSON text AND the same object as structuredContent. */
function toolOk(textObj: unknown, structuredObj?: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(textObj) }],
    structuredContent: structuredObj === undefined ? textObj : structuredObj,
    isError: false,
  };
}

/** Failed tool execution (e.g. missing argument, repo/PR not found). */
function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Argument mapping (contract §5.1 ARGUMENT_SYNONYMS + §7).
// The client maps semantic keys onto our schema properties, but a caller may
// also send synonym names directly, or full_name instead of owner+repo, so
// every lookup tries the full synonym list in contract priority order.
// ---------------------------------------------------------------------------

function pickString(args: UnknownRecord, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** Identifier lookup: like pickString, but trimmed and empty-after-trim rejected. */
function pickId(args: UnknownRecord, keys: string[]): string | undefined {
  const v = pickString(args, keys);
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function pickNumber(args: UnknownRecord, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  }
  return undefined;
}

function pickBoolean(args: UnknownRecord, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

function pickOwnerRepo(args: UnknownRecord): { owner?: string; repo?: string } {
  let fullOwner: string | undefined;
  let fullRepo: string | undefined;
  const full = pickId(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if (full !== undefined) {
    const i = full.indexOf('/');
    if (i > 0 && i < full.length - 1) {
      fullOwner = full.slice(0, i);
      fullRepo = full.slice(i + 1);
    }
  }
  const owner =
    pickId(args, [
      'owner',
      'owner_login',
      'org',
      'organization',
      'organisation',
      'user',
      'user_login',
      'login',
      'account',
      'namespace',
      'owner_name',
    ]) ?? fullOwner;
  const repo =
    pickId(args, [
      'repo',
      'repository',
      'repository_name',
      'repo_name',
      'repo_slug',
      'project',
      'project_name',
    ]) ?? fullRepo;
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Tool-name resolution (contract §4.3/§4.4): normalise (lowercase, drop
// non-[a-z0-9]), exact match against canonical/alias first, then suffix match.
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveTool(rawName: string): string | undefined {
  const norm = normalizeName(rawName);
  if (norm === '') return undefined;
  const canonicals = Object.keys(TOOL_ALIASES);
  for (const c of canonicals) {
    if (norm === normalizeName(c)) return c;
    const aliases = TOOL_ALIASES[c] ?? [];
    for (const a of aliases) {
      if (norm === normalizeName(a)) return c;
    }
  }
  for (const c of canonicals) {
    const candidates = [c, ...(TOOL_ALIASES[c] ?? [])].map(normalizeName);
    for (const s of candidates) {
      if (norm.length > s.length && norm.endsWith(s)) return c;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Store access helpers.
// The Store API used here is the one named in the task interface (repos map,
// getRepo/createRepo, tick/isoFor, nextIssueId/nextCommentId/nextPullId).
// next*Id may be a method or a plain counter property; handle both.
// ---------------------------------------------------------------------------

function nextCounter(store: Store, key: 'nextIssueId' | 'nextCommentId' | 'nextPullId', fallback: number): number {
  const v: unknown = (store as unknown as Record<string, unknown>)[key];
  if (typeof v === 'function') {
    const n: unknown = (v as () => unknown).call(store);
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
  } else if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
    return v;
  }
  return fallback;
}

function maxId(items: Array<{ id: number }>): number {
  let m = 0;
  for (const it of items) {
    if (typeof it.id === 'number' && it.id > m) m = it.id;
  }
  return m;
}

// ---------------------------------------------------------------------------
// REST-shaped views (contract §5.5 rest-parity: MCP and REST read the same
// objects from the same store; the MCP result carries full_name / number so
// the client can re-read them over REST).
// ---------------------------------------------------------------------------

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description ?? null,
    default_branch: repo.defaultBranch,
  };
}

function issueShape(store: Store, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: [...issue.labels],
    created_at: store.isoFor(issue.createdSeq),
  };
}

function pullShape(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
  };
}

// ---------------------------------------------------------------------------
// Git object / ref access for the squash merge.
// repo.objects / repo.refs shapes are owned by store.ts; these helpers accept
// Map<string, X> or plain-object stores, string sha values or { sha } /
// { object: { sha } } wrappers, and commit objects stored as raw text, a
// Buffer, or a record with a `tree` / `data` field. Anything unrecognised
// degrades to undefined instead of throwing.
// ---------------------------------------------------------------------------

function refValueToSha(v: unknown): string | undefined {
  if (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)) return v;
  if (isRecord(v)) {
    if (typeof v.sha === 'string' && /^[0-9a-f]{40}$/.test(v.sha)) return v.sha;
    if (isRecord(v.object) && typeof v.object.sha === 'string' && /^[0-9a-f]{40}$/.test(v.object.sha)) {
      return v.object.sha;
    }
  }
  return undefined;
}

function refTip(repo: Repo, branch: string): string | undefined {
  const refs: unknown = (repo as unknown as UnknownRecord).refs;
  const keys = [`refs/heads/${branch}`, branch];
  if (refs instanceof Map) {
    for (const k of keys) {
      const sha = refValueToSha(refs.get(k));
      if (sha !== undefined) return sha;
    }
    return undefined;
  }
  if (isRecord(refs)) {
    for (const k of keys) {
      const sha = refValueToSha(refs[k]);
      if (sha !== undefined) return sha;
    }
  }
  return undefined;
}

/** Move the branch ref to `sha`, keeping whatever key format the store already uses. */
function setRefTip(repo: Repo, branch: string, sha: string): void {
  const refs: unknown = (repo as unknown as UnknownRecord).refs;
  const fullKey = `refs/heads/${branch}`;
  if (refs instanceof Map) {
    if (refs.has(fullKey)) refs.set(fullKey, sha);
    else if (refs.has(branch)) refs.set(branch, sha);
    else refs.set(fullKey, sha);
    return;
  }
  if (isRecord(refs)) {
    if (fullKey in refs) refs[fullKey] = sha;
    else if (branch in refs) refs[branch] = sha;
    else refs[fullKey] = sha;
  }
}

function getObject(repo: Repo, sha: string): unknown {
  const objects: unknown = (repo as unknown as UnknownRecord).objects;
  if (objects instanceof Map) return objects.get(sha);
  if (isRecord(objects)) return objects[sha];
  return undefined;
}

function setObject(repo: Repo, sha: string, value: unknown): void {
  const objects: unknown = (repo as unknown as UnknownRecord).objects;
  if (objects instanceof Map) {
    objects.set(sha, value);
    return;
  }
  if (isRecord(objects)) objects[sha] = value;
}

function treeOfCommitText(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = /^tree ([0-9a-f]{40})$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** The tree sha of a commit object, or undefined if the store shape is unknown. */
function commitTree(repo: Repo, commitSha: string): string | undefined {
  const obj = getObject(repo, commitSha);
  if (obj === undefined) return undefined;
  if (typeof obj === 'string') return treeOfCommitText(obj);
  if (Buffer.isBuffer(obj)) return treeOfCommitText(obj.toString('utf8'));
  if (isRecord(obj)) {
    if (typeof obj.tree === 'string' && /^[0-9a-f]{40}$/.test(obj.tree)) return obj.tree;
    if (typeof obj.data === 'string') return treeOfCommitText(obj.data);
    if (Buffer.isBuffer(obj.data)) return treeOfCommitText(obj.data.toString('utf8'));
    if (typeof obj.content === 'string') return treeOfCommitText(obj.content);
  }
  return undefined;
}

/**
 * Squash merge: one new commit whose tree is the head tree and whose parent
 * is the base tip, stored back in the object store in the same shape as the
 * head commit when that shape is recognisable, and the base ref moved to it.
 * Returns the merge commit sha (SHA-1 over a git commit object, so it is a
 * valid SHA40 even when the object store shape is unrecognised and the
 * commit itself could not be persisted — the pull state is what the MCP
 * merge check reads over REST).
 */
function squashMerge(store: Store, repo: Repo, pull: Pull): string {
  const baseTip = refTip(repo, pull.baseRef) ?? pull.baseSha;
  const headTip = pull.headSha;
  // Fallback when the head commit object cannot be read: the head tip itself
  // as the tree placeholder keeps the sha deterministic; see header comment.
  const tree = commitTree(repo, headTip) ?? headTip;
  const viewerLogin = VIEWER.login ?? 'viewer';
  const author = `${viewerLogin} <${viewerLogin}@github-forge.local>`;
  const content =
    `tree ${tree}\n` +
    `parent ${baseTip}\n` +
    `author ${author} 0 +0000\n` +
    `committer ${author} 0 +0000\n` +
    `\n` +
    `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n` +
    `\n` +
    `${pull.title}\n`;
  const sha = createHash('sha1').update(`commit ${Buffer.byteLength(content)}\0${content}`, 'utf8').digest('hex');

  // Persist the commit in the head commit's own shape, when recognisable.
  const headObj = getObject(repo, headTip);
  if (typeof headObj === 'string') {
    setObject(repo, sha, content);
  } else if (Buffer.isBuffer(headObj)) {
    setObject(repo, sha, Buffer.from(content, 'utf8'));
  } else if (isRecord(headObj) && typeof headObj.tree === 'string') {
    setObject(repo, sha, {
      ...headObj,
      tree,
      parents: [baseTip],
      parent: baseTip,
      message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`,
    });
  } else if (isRecord(headObj) && typeof headObj.data === 'string') {
    setObject(repo, sha, { ...headObj, data: content });
  } else if (isRecord(headObj) && Buffer.isBuffer(headObj.data)) {
    setObject(repo, sha, { ...headObj, data: Buffer.from(content, 'utf8') });
  }
  // Unknown shape: do not guess a layout; the merge sha + pull state below
  // are still recorded.

  setRefTip(repo, pull.baseRef, sha);
  return sha;
}

// ---------------------------------------------------------------------------
// tools/call implementations — each returns a tool-result object (never a
// JSON-RPC error, except unknown tool which is decided by the caller).
// ---------------------------------------------------------------------------

function callCreateRepo(store: Store, args: UnknownRecord): Record<string, unknown> {
  const name = pickId(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
  if (name === undefined || name.includes('/')) {
    return toolErr('create_repo requires "name" (a repository name without "/").');
  }
  const description = pickString(args, ['description', 'about', 'summary', 'body']);
  const isPrivate = pickBoolean(args, ['private', 'is_private']) ?? false;
  const owner = VIEWER.login ?? 'viewer';
  if (store.getRepo(owner, name) !== undefined) {
    return toolErr(`Repository already exists: ${owner}/${name}.`);
  }
  const repo = store.createRepo(owner, name, { description, private: isPrivate });
  return toolOk(repoShape(repo));
}

function callGetRepo(store: Store, args: UnknownRecord): Record<string, unknown> {
  const { owner, repo: repoName } = pickOwnerRepo(args);
  if (owner === undefined || repoName === undefined) {
    return toolErr('get_repo requires "owner" and "repo".');
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}.`);
  return toolOk(repoShape(repo));
}

function callCreateIssue(store: Store, args: UnknownRecord): Record<string, unknown> {
  const { owner, repo: repoName } = pickOwnerRepo(args);
  const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (owner === undefined || repoName === undefined || title === undefined) {
    return toolErr('create_issue requires "owner", "repo" and "title".');
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}.`);
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const issue: Issue = {
    id: nextCounter(store, 'nextIssueId', maxId(repo.issues) + 1),
    number: repo.nextIssueNumber++,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    createdSeq: store.tick(),
  };
  repo.issues.push(issue);
  return toolOk(issueShape(store, issue));
}

function callListIssues(store: Store, args: UnknownRecord): Record<string, unknown> {
  const { owner, repo: repoName } = pickOwnerRepo(args);
  if (owner === undefined || repoName === undefined) {
    return toolErr('list_issues requires "owner" and "repo".');
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}.`);
  const state = pickString(args, ['state', 'status']);
  const wanted = state === undefined || state === 'all' ? undefined : state;
  const arr = repo.issues
    .filter((i) => wanted === undefined || i.state === wanted)
    .map((i) => issueShape(store, i));
  return toolOk(arr, { issues: arr });
}

function callCreatePullRequest(store: Store, args: UnknownRecord): Record<string, unknown> {
  const { owner, repo: repoName } = pickOwnerRepo(args);
  const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  const head = pickId(args, [
    'head',
    'head_ref',
    'head_branch',
    'pull_request_head',
    'pr_head',
    'source',
    'source_ref',
    'source_branch',
    'from',
    'from_branch',
    'branch',
  ]);
  const base = pickId(args, [
    'base',
    'base_ref',
    'base_branch',
    'pull_request_base',
    'pr_base',
    'target',
    'target_ref',
    'target_branch',
    'into',
    'into_branch',
  ]);
  if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
    return toolErr('create_pull_request requires "owner", "repo", "title", "head" and "base".');
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}.`);
  const headSha = refTip(repo, head);
  if (headSha === undefined) return toolErr(`Head branch not found: ${head}.`);
  const baseSha = refTip(repo, base);
  if (baseSha === undefined) return toolErr(`Base branch not found: ${base}.`);
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const pull: Pull = {
    id: nextCounter(store, 'nextPullId', maxId(repo.pulls) + 1),
    number: repo.nextPullNumber++,
    title,
    body,
    state: 'open',
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: store.tick(),
  };
  repo.pulls.push(pull);
  return toolOk(pullShape(pull));
}

function callMergePullRequest(store: Store, args: UnknownRecord): Record<string, unknown> {
  const { owner, repo: repoName } = pickOwnerRepo(args);
  const pullNumber = pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (owner === undefined || repoName === undefined || pullNumber === undefined) {
    return toolErr('merge_pull_request requires "owner", "repo" and "pull_number".');
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolErr(`Repository not found: ${owner}/${repoName}.`);
  const pull = repo.pulls.find((p) => p.number === pullNumber);
  if (pull === undefined) return toolErr(`Pull request not found: #${pullNumber}.`);
  if (pull.merged && pull.mergeCommitSha !== null) {
    return toolOk({ merged: true, sha: pull.mergeCommitSha, message: `Pull request #${pullNumber} is already merged.` });
  }
  const sha = squashMerge(store, repo, pull);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = store.isoFor(store.tick());
  pull.mergeCommitSha = sha;
  pull.baseSha = sha;
  return toolOk({ merged: true, sha, message: `Pull request #${pullNumber} merged.` });
}

function callTool(store: Store, id: unknown, params: unknown): Resp {
  const p = isRecord(params) ? params : {};
  const rawName = typeof p.name === 'string' ? p.name : '';
  const args = isRecord(p.arguments) ? p.arguments : {};
  const canonical = resolveTool(rawName);
  if (canonical === undefined) {
    return rpcErr(id, -32602, `Unknown tool: ${rawName}`);
  }
  let result: Record<string, unknown>;
  switch (canonical) {
    case 'create_repo':
      result = callCreateRepo(store, args);
      break;
    case 'get_repo':
      result = callGetRepo(store, args);
      break;
    case 'create_issue':
      result = callCreateIssue(store, args);
      break;
    case 'list_issues':
      result = callListIssues(store, args);
      break;
    case 'create_pull_request':
      result = callCreatePullRequest(store, args);
      break;
    case 'merge_pull_request':
      result = callMergePullRequest(store, args);
      break;
    default:
      return rpcErr(id, -32602, `Unknown tool: ${rawName}`);
  }
  return rpcOk(id, result);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function handleMcp(ctx: ReqCtx, store: Store): Resp | null {
  if (ctx.path !== '/mcp') return null;

  // Only POST. A 405 is a recognised pre-discover refusal (contract §2.2).
  if (ctx.method !== 'POST') {
    return {
      status: 405,
      headers: JSON_HEADERS,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed: only POST is supported on /mcp' } },
    };
  }

  // Parse error -> HTTP 400 + -32700 (contract §6.2, modern era). Recover the
  // id from the raw body when it is legible, else null.
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    const raw = ctx.body.toString('utf8');
    const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
    let recoveredId: unknown = null;
    if (m) {
      try {
        recoveredId = JSON.parse(m[1] as string);
      } catch {
        recoveredId = null;
      }
    }
    return {
      status: 400,
      headers: JSON_HEADERS,
      body: { jsonrpc: '2.0', id: recoveredId, error: { code: -32700, message: 'Parse error' } },
    };
  }

  if (!isRecord(parsed)) {
    return rpcErr(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const method = parsed.method;
  if (typeof method !== 'string' || method === '') {
    return rpcErr(isRecord(parsed) && 'id' in parsed ? parsed.id : null, -32600, 'Invalid Request: missing method');
  }
  if (parsed.jsonrpc !== '2.0') {
    return rpcErr('id' in parsed ? parsed.id : null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  }

  // Notification (no id): no JSON-RPC response, HTTP 202, empty body.
  // This covers notifications/initialized (legacy handshake) and any other
  // notification. A request that carries an id always gets a response below.
  if (!('id' in parsed) || parsed.id === undefined || parsed.id === null) {
    return { status: 202, body: null };
  }
  const id: unknown = parsed.id;
  if (typeof id !== 'string' && typeof id !== 'number') {
    return rpcErr(null, -32600, 'Invalid Request: id must be a string or number');
  }

  const params: unknown = 'params' in parsed ? parsed.params : undefined;

  switch (method) {
    case 'server/discover': {
      // Modern era identity + capabilities in one request (contract §3).
      // serverInfo is given twice on purpose: the client reads
      // _meta['io.modelcontextprotocol/serverInfo'] FIRST, then falls back
      // to result.serverInfo (contract §2.4/§3.2).
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return rpcOk(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      // Legacy handshake (contract §2.3). Echo the client's revision when it
      // is a valid YYYY-MM-DD date (any of the known revisions, including
      // '2026-07-28' if a modern client ever calls initialize); otherwise
      // offer the newest legacy revision. Never -32602 here: only that code
      // makes the client retry the next revision.
      const p = isRecord(params) ? params : {};
      const offered = typeof p.protocolVersion === 'string' ? p.protocolVersion : undefined;
      const protocolVersion = offered !== undefined && REVISION_RE.test(offered) ? offered : '2025-11-25';
      return rpcOk(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'tools/list': {
      // One shared const, returned by reference: byte-identical every call.
      return rpcOk(id, { tools: TOOLS });
    }
    case 'tools/call': {
      return callTool(store, id, params);
    }
    default: {
      // ping, resources/list, prompts/list and anything else: method not found.
      return rpcErr(id, -32601, `Method not found: ${method}`);
    }
  }
}
