/**
 * The Local Agent HTTP server — Phase 3B skeleton.
 *
 * ONE route exists: GET /health. There is no /source/*, /session/*, /pair/*, or
 * /gateway/* route — any such path 404s. Nothing here reads a file, reads a
 * database, connects to Azure, or returns customer data. The only state is the
 * config passed in; there is no persistence of any kind.
 *
 * Security applied on every request:
 *   - Origin: if an Origin header is present it MUST be an exact allowlist match,
 *     else 403 INVALID_ORIGIN. (Absent Origin = a non-browser liveness call.)
 *     The reflected CORS origin is the exact request origin, NEVER '*'.
 *   - Auth boundary: if the custom auth header is present it must be well-formed,
 *     else 401 INVALID_TOKEN. (Absent = liveness; real session validation is 3C.)
 *   - Oversized requests are rejected (413) before any handling.
 *   - Errors are sanitized to a code + generic message; input is never echoed.
 *   - Logs carry method/path/status/decision/mode ONLY — never a header value,
 *     token, origin string, or body.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { GatewayErrorCode } from '@dpdp/shared';
import type { AgentConfig } from './config';
import { evaluateOrigin } from './origin';
import { inspectAuthHeader, GATEWAY_AUTH_HEADER } from './auth';
import { buildHealth } from './health';
import { DATA_PLANE_PATHS, handleDataPlaneRequest, type DataPlane } from './data-plane';
import { STORAGE_PLANE_PATHS, handleStoragePlaneRequest, type StoragePlane } from './storage/storage-plane';

/** Requests larger than this are refused outright (there is no legitimate body). */
const MAX_CONTENT_LENGTH = 4096;

const ERROR_MESSAGE: Record<string, string> = {
  INVALID_ORIGIN: 'Origin not allowed.',
  INVALID_TOKEN: 'Authentication header is malformed.',
  NOT_FOUND: 'Not found.',
  RATE_LIMITED: 'Request too large.',
  METHOD_NOT_ALLOWED: 'Method not allowed.',
};

type LogFn = (line: string) => void;

export interface AgentServerOptions {
  /** When provided, the agent also serves the data-plane routes (Phase 3D).
   *  Absent (Phase-3B skeleton) → only GET /health exists. */
  dataPlane?: DataPlane;
  /** When provided, the agent also serves the storage-plane routes (folder
   *  browse/create/verify — a SEPARATE capability from the data plane). */
  storagePlane?: StoragePlane;
  log?: LogFn;
}

/** Read a bounded JSON body. The oversized guard already capped content-length,
 *  so this never buffers more than MAX_CONTENT_LENGTH bytes. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CONTENT_LENGTH) {
        reject(new Error('RATE_LIMITED'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('BAD_REQUEST'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Never expose what the agent is or where it reaches; keep responses lean.
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: GatewayErrorCode | string): void {
  sendJson(res, status, { error: code, message: ERROR_MESSAGE[code] ?? 'Request failed.' });
}

/**
 * Build (but do not start) the agent's HTTP server for a given config. Exported
 * so tests can drive it on an ephemeral port. `log` defaults to a safe console
 * line writer that never receives header/token/body values.
 */
export function createAgentServer(config: AgentConfig, options: AgentServerOptions = {}): Server {
  const log: LogFn = options.log ?? (() => {});
  const dataPlane = options.dataPlane;
  const storagePlane = options.storagePlane;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const originDecision = evaluateOrigin(origin, config.allowedOrigins);

    const done = (status: number, note: string): void => {
      // Metadata only: method, path, status, the origin DECISION (not the value),
      // and the network mode. No header values, no token, no body.
      log(`${method} ${path} -> ${status} [origin:${originDecision} mode:${config.networkMode}] ${note}`);
    };

    // 0. Oversized guard — before anything else.
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH) {
      sendError(res, 413, 'RATE_LIMITED');
      return done(413, 'oversized');
    }

    // 1. Origin: a presented Origin must be an exact allowlist match.
    if (originDecision === 'denied') {
      sendError(res, 403, 'INVALID_ORIGIN');
      return done(403, 'origin-denied');
    }

    // CORS headers only ever reflect the EXACT allowed origin, never '*'.
    const corsHeaders: Record<string, string> =
      originDecision === 'allowed' && origin
        ? {
            'access-control-allow-origin': origin,
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': `content-type, ${GATEWAY_AUTH_HEADER}`,
            vary: 'Origin',
          }
        : {};

    // 2. CORS preflight for the custom auth header.
    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return done(204, 'preflight');
    }

    // 2b. Data-plane routes (Phase 3D) — only when a data plane is wired. The
    //     browser presents its session token in the auth header; the data plane
    //     validates it and dispatches to the connector. Raw rows returned here go
    //     straight back to this authorized browser — never to Azure, never stored.
    if (dataPlane && DATA_PLANE_PATHS.has(path)) {
      const header = req.headers[GATEWAY_AUTH_HEADER];
      const sessionToken = typeof header === 'string' ? header : undefined;
      void readJsonBody(req)
        .then(async (body) => {
          const reply = await handleDataPlaneRequest(dataPlane, { method, path, sessionToken, body });
          sendJson(res, reply.status, reply.json, corsHeaders);
          done(reply.status, 'data-plane');
        })
        .catch((err: Error) => {
          const code = err.message === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'BAD_REQUEST';
          sendError(res, code === 'RATE_LIMITED' ? 413 : 400, code);
          done(code === 'RATE_LIMITED' ? 413 : 400, 'data-plane-error');
        });
      return;
    }

    // 2c. Storage-plane routes — the SEPARATE folder browse/create/verify
    //     capability. A data-plane session cannot be reused here (different
    //     path family, different session store) and vice versa.
    if (storagePlane && STORAGE_PLANE_PATHS.has(path)) {
      const header = req.headers[GATEWAY_AUTH_HEADER];
      const sessionToken = typeof header === 'string' ? header : undefined;
      void readJsonBody(req)
        .then(async (body) => {
          const reply = await handleStoragePlaneRequest(storagePlane, { method, path, sessionToken, body });
          sendJson(res, reply.status, reply.json, corsHeaders);
          done(reply.status, 'storage-plane');
        })
        .catch((err: Error) => {
          const code = err.message === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'BAD_REQUEST';
          sendError(res, code === 'RATE_LIMITED' ? 413 : 400, code);
          done(code === 'RATE_LIMITED' ? 413 : 400, 'storage-plane-error');
        });
      return;
    }

    // 3. Route. Only GET /health exists.
    if (path !== '/health') {
      sendError(res, 404, 'NOT_FOUND');
      return done(404, 'no-such-route');
    }
    if (method !== 'GET') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED');
      return done(405, 'bad-method');
    }

    // 4. Auth boundary: if a token is presented it must be well-formed. Absent is
    //    fine for liveness. The value itself is never inspected further or logged.
    const auth = inspectAuthHeader(req.headers[GATEWAY_AUTH_HEADER]);
    if (auth.present && !auth.valid) {
      sendError(res, 401, 'INVALID_TOKEN');
      return done(401, 'auth-malformed');
    }

    // 5. Success — metadata only.
    sendJson(res, 200, buildHealth(config.networkMode), corsHeaders);
    return done(200, 'health');
  });
}
