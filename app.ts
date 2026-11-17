// The forge's HTTP surface: routing, auth, body parsing and reply framing.
// Module handlers live in git.ts / rest.ts / graphql.ts / mcp.ts; the single in-memory
// store lives in store.ts. main.ts (lifecycle) stays untouched.
//
// Auth: every route except GET /healthz requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
// (exact string match). Missing/wrong token -> 401 JSON. A repo under a different owner
// than the token's viewer is a 404, never a 403 (handled inside the modules).
// Every reply carries a non-empty X-GitHub-Request-Id (`req-<counter>`, deterministic per
// request order) and is JSON unless a module sets another content-type (git smart HTTP).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest, type ReqCtx, type Resp } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Read the whole request body (git packs are small; cap at 64 MiB as a safety valve). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Lower-cased request headers as a plain record. */
function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value) && value.length > 0) out[key.toLowerCase()] = value[0] as string;
  }
  return out;
}

/** Serialize one module reply: Buffer as-is, string as-is, object as JSON, null as empty. */
function sendResp(res: ServerResponse, resp: Resp, reqId: string, host: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': reqId, ...(resp.headers ?? {}) };
  let body: Buffer;
  if (resp.body === null || resp.body === undefined) {
    body = Buffer.alloc(0);
  } else if (Buffer.isBuffer(resp.body)) {
    body = resp.body;
  } else if (typeof resp.body === 'string') {
    body = Buffer.from(resp.body, 'utf8');
  } else {
    body = Buffer.from(`${JSON.stringify(resp.body)}\n`, 'utf8');
    if (!('content-type' in headers)) headers['content-type'] = JSON_TYPE;
  }
  // Pagination Link headers are built relative by the modules; the suite requires absolute
  // URLs on the same origin, so rewrite them here against the request's Host.
  if (typeof headers.link === 'string' && host !== '') {
    headers.link = headers.link.replace(/<(\/[^>]*)>/g, `<http://${host}$1>`);
  }
  if (!('content-type' in headers) && body.length > 0) headers['content-type'] = JSON_TYPE;
  headers['content-length'] = String(body.length);
  res.writeHead(resp.status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, reqId: string): void {
  sendResp(res, { status, body: body as Record<string, unknown> }, reqId, '');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let reqCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const reqId = `req-${++reqCounter}`;
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const headers = headersOf(req);
      const host = headers.host ?? '';

      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth here.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, reqId);
          return;
        }

        // Auth: everything else needs the exact bearer token.
        const auth = headers.authorization ?? '';
        if (token === '' || auth !== `Bearer ${token}`) {
          sendJson(res, 401, { message: 'Unauthorized' }, reqId);
          return;
        }

        const rawBody = await readBody(req);
        const ctx: ReqCtx = { method, path, query: queryOf(req), headers, body: rawBody, authed: true, reqId };

        // MCP gets the raw body (it must answer -32700 itself on malformed JSON).
        if (path === '/mcp') {
          const out = handleMcp(ctx, store);
          if (out !== null) {
            sendResp(res, out, reqId, host);
            return;
          }
        } else if (path === '/api/graphql') {
          if (rawBody.length > 0) {
            try {
              JSON.parse(rawBody.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Malformed JSON body' }, reqId);
              return;
            }
          }
          const out = handleGraphql(ctx, store);
          if (out !== null) {
            sendResp(res, out, reqId, host);
            return;
          }
        } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (rawBody.length > 0) {
            try {
              JSON.parse(rawBody.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Malformed JSON body' }, reqId);
              return;
            }
          }
          const out = handleRest(ctx, store);
          if (out !== null) {
            sendResp(res, out, reqId, host);
            return;
          }
        } else if (path.includes('.git/')) {
          const out = handleGit(ctx, store);
          if (out !== null) {
            sendResp(res, out, reqId, host);
            return;
          }
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, reqId);
      } catch (err) {
        process.stderr.write(`[app] ${reqId} ${method} ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          sendJson(res, 500, { message: 'Internal Server Error' }, reqId);
        } catch {
          // Response already gone; nothing left to do.
        }
      }
    })();
  });
}
