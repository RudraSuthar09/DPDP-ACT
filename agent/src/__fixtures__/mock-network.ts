/**
 * TEST-ONLY local network doubles: a forward proxy (HTTP CONNECT) and a mock
 * DPDP backend. These are SIMULATIONS for automated tests; they are not a
 * real corporate proxy and prove nothing about any particular vendor's
 * product. Excluded from the installer bundle (dist\__fixtures__ is pruned).
 */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';

export const TLS_DIR = path.join(__dirname, 'tls');
export const TEST_CA_PEM = readFileSync(path.join(TLS_DIR, 'test-ca.pem'), 'utf8');
/** Reserved TLD: never resolves, so only the mock proxy can reach it. */
export const TUNNEL_HOST = 'gateway-backend.test';

export interface ProxyConnect {
  target: string;
  proxyAuthorization: string | undefined;
}

export interface MockProxy {
  port: number;
  url: string;
  connects: ProxyConnect[];
  /** Every byte the client sent INTO tunnels (to prove TLS is end to end). */
  tunnelledBytes(): Buffer;
  close(): Promise<void>;
}

/**
 * A CONNECT proxy. TUNNEL_HOST is dialled at 127.0.0.1; other targets as
 * given. Optional Basic auth (answers 407 otherwise), a forced status for
 * every CONNECT, or dropping every CONNECT without any response.
 */
export async function startMockProxy(
  opts: { auth?: { username: string; password: string }; forceStatus?: number; dropConnections?: boolean } = {},
): Promise<MockProxy> {
  const connects: ProxyConnect[] = [];
  const chunks: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((_req, res) => {
    res.writeHead(405).end();
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const auth = req.headers['proxy-authorization'];
    connects.push({ target: req.url ?? '', proxyAuthorization: auth });
    const expected = opts.auth ? `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString('base64')}` : null;
    if (opts.forceStatus) {
      client.end(`HTTP/1.1 ${opts.forceStatus} Forced\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (expected && auth !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = req.url ?? '';
    const sep = target.lastIndexOf(':');
    const host = target.slice(0, sep).replace(/^\[|\]$/g, '');
    const port = Number(target.slice(sep + 1));
    if (opts.dropConnections) {
      client.destroy();
      return;
    }
    const upstream = netConnect(port, host === TUNNEL_HOST ? '127.0.0.1' : host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    connects,
    tunnelledBytes: () => Buffer.concat(chunks),
    close: () => closeServer(server, sockets),
  };
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  /** Raw request body (JSON text), for asserting what the agent sent. */
  body: string;
}

export interface MockBackend {
  port: number;
  requests: RecordedRequest[];
  deviceToken: string;
  close(): Promise<void>;
}

/** A minimal DPDP backend: enroll, heartbeat and deenroll. */
export async function startMockBackend(
  opts: {
    tls?: 'localhost' | 'wrong-host' | null;
    host?: string;
    /** Listen on this port (e.g. to come back after a simulated outage). */
    port?: number;
    statusFor?: Record<string, number>;
    /** Answer every request with an HTML 404 page, like a web front end. */
    htmlSite?: boolean;
    /** JSON body for POST /gateway/heartbeat (default {}). */
    heartbeatReply?: unknown;
    /** Replies to POST /gateway/submissions/claim, consumed in order; then
     *  "nothing pending". */
    claimReplies?: unknown[];
  } = {},
): Promise<MockBackend> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const deviceToken = `${b64({ alg: 'none' })}.${b64({ tenant_id: 'tenant-test' })}.sig`;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const recorded: RecordedRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: '' };
    requests.push(recorded);
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (recorded.body += chunk));
    req.on('end', () => {
      if (opts.htmlSite) {
        res.writeHead(404, { 'content-type': 'text/html' }).end('<!DOCTYPE html><html><body>This page could not be found.</body></html>');
        return;
      }
      res.setHeader('content-type', 'application/json');
      const forced = opts.statusFor?.[req.url ?? ''];
      if (forced) {
        res.statusCode = forced;
        res.end('{"message":"forced"}');
      } else if (req.url === '/gateway/enroll') {
        res.end(JSON.stringify({ device: { id: 'device-test' }, deviceToken }));
      } else if (req.url === '/gateway/pair/redeem') {
        // Pairing redemption: a short-lived data-plane session for the source.
        res.end(JSON.stringify({ sessionToken: `mock-session-${requests.length}`, expiresAt: new Date(Date.now() + 300_000).toISOString() }));
      } else if (req.url === '/gateway/submissions/claim') {
        const next = opts.claimReplies?.shift();
        res.end(JSON.stringify(next ?? { ready: false, reason: 'NOTHING_PENDING' }));
      } else if (req.url?.startsWith('/gateway/submissions/') && req.url.endsWith('/ack')) {
        res.end('{"ok":true}');
      } else if (req.url === '/gateway/heartbeat' && opts.heartbeatReply !== undefined) {
        res.end(JSON.stringify(opts.heartbeatReply));
      } else {
        res.end('{}');
      }
    });
  };
  const server: Server = opts.tls
    ? createHttpsServer(
        { key: readFileSync(path.join(TLS_DIR, `${opts.tls}.key`)), cert: readFileSync(path.join(TLS_DIR, `${opts.tls}.pem`)) },
        handler,
      )
    : createHttpServer(handler);
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, requests, deviceToken, close: () => closeServer(server, sockets) };
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const s of sockets) s.destroy();
  return new Promise((r) => server.close(() => r()));
}

/** A TCP port with nothing listening on it (for "proxy is down"). */
export async function closedPort(): Promise<number> {
  const s = createHttpServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}
