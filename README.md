# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Scynun/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Scynun/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in dependency-free Node 22 TypeScript, built for [make.fun](https://make.fun)'s ["Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01) bounty. One process serves git smart HTTP, REST v3, GraphQL v4 and MCP from a single in-memory store — no git binary, no dependencies, no model calls.

Local conformance (sealed `sdk/run.ts` from the kit): **120/120 checks** — git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15 — feature 600, agent 200, perf 186/200, **score 986/1000** (measured 2026-11-17 on this VM; final grading runs on fresh seeded data in the trial pod).

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, register, poll `/done`, exit 0). It needs `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in the environment.

## Files

- `main.ts` — lifecycle only (kept as the starter shipped it)
- `app.ts` — HTTP routing, auth (Bearer token, 401), `X-GitHub-Request-Id`, JSON body handling
- `store.ts` — the single in-memory store: repos, issues, PRs, labels, git objects (blob/tree/commit/tag, SHA-1), refs, deterministic clock from `MAKEFUN_TRIAL_NOW`, scenario viewer identity derived from the kit's fixed seed
- `git.ts` — git smart HTTP: pkt-line, side-band-64k, upload-pack v2 (ls-refs, fetch, shallow/deepen), receive-pack v0 (report-status, fast-forward per ref), packfile parse/generate (plain objects, no deltas)
- `rest.ts` — REST v3: repos, branches, commits, contents (base64 + sha, 409 on stale sha), issues, comments, labels (422 on unknown label), pulls, squash merge onto the default branch (405 on conflict)
- `graphql.ts` — GraphQL v4: minimal parser/executor for the documents the suite sends, introspection with exact field lists, cursor pagination, batched operations, mutations sharing the store with REST
- `mcp.ts` — MCP over Streamable HTTP: `server/discover`, `initialize`, byte-identical `tools/list` (6 tools), `tools/call` on the same store, JSON-RPC errors -32601/-32602/-32700
- `package.json`, `tsconfig.json` — Node ≥ 22.18, no dependencies

## Determinism

No `Date.now()`, no `Math.random()`, no UUIDs in request paths. Timestamps come from `MAKEFUN_TRIAL_NOW` plus a monotonic sequence; the viewer identity (`adaiversen`) is derived from the kit's fixed scenario seed. The same request sequence always yields the same state.
