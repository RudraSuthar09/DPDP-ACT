/**
 * TEST-ONLY minimal PostgreSQL wire-protocol server. NOT PostgreSQL: it
 * implements just enough of protocol 3.0 for the real `pg` driver to
 * negotiate TLS (SSLRequest -> 'S' + TLS handshake, or 'N'), authenticate
 * (AuthenticationOk, no password check) and run one simple query that
 * returns a single row. Used to exercise the driver's REAL TLS behaviour with
 * the TEST-ONLY certificates in ./tls. Excluded from the installer bundle.
 */
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { TLSSocket } from 'node:tls';

const TLS_DIR = path.join(__dirname, 'tls');
const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_3 = 196608;

export type MockPgMode =
  /** Accept SSLRequest ('S') and serve TLS with the given certificate. */
  | { tls: 'localhost' | 'wrong-host' }
  /** Refuse TLS ('N'); a client asking for TLS must then give up. */
  | { refuseTls: true }
  /** Answer 'S', then close before the handshake. */
  | { dropAfterSslRequest: true }
  /** Plain server for clients that do not request TLS. */
  | { plaintext: true };

export interface MockPostgres {
  port: number;
  /** Startup messages received over TLS / in plaintext. */
  tlsStartups: number;
  plaintextStartups: number;
  sslRequests: number;
  queries: string[];
  close(): Promise<void>;
}

function msg(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type, 'latin1'), len, body]);
}
const int16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const int32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

function serveProtocol(sock: Socket | TLSSocket, state: MockPostgres, overTls: boolean): void {
  let buf = Buffer.alloc(0);
  let started = false;
  sock.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!started) {
        if (buf.length < 8) return;
        const len = buf.readInt32BE(0);
        if (buf.length < len) return;
        const code = buf.readInt32BE(4);
        buf = buf.subarray(len);
        if (code !== PROTOCOL_3) {
          sock.destroy();
          return;
        }
        started = true;
        if (overTls) state.tlsStartups += 1;
        else state.plaintextStartups += 1;
        sock.write(Buffer.concat([msg('R', int32(0)), msg('S', Buffer.concat([cstr('server_version'), cstr('16.0')])), msg('Z', Buffer.from('I'))]));
        continue;
      }
      if (buf.length < 5) return;
      const type = String.fromCharCode(buf[0]!);
      const len = buf.readInt32BE(1);
      if (buf.length < len + 1) return;
      const body = buf.subarray(5, len + 1);
      buf = buf.subarray(len + 1);
      if (type === 'X') {
        sock.end();
        return;
      }
      if (type === 'Q') {
        state.queries.push(body.subarray(0, body.length - 1).toString('utf8'));
        const field = Buffer.concat([cstr('ok'), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]);
        sock.write(
          Buffer.concat([
            msg('T', Buffer.concat([int16(1), field])),
            msg('D', Buffer.concat([int16(1), int32(1), Buffer.from('1')])),
            msg('C', cstr('SELECT 1')),
            msg('Z', Buffer.from('I')),
          ]),
        );
      }
    }
  });
}

export async function startMockPostgres(mode: MockPgMode): Promise<MockPostgres> {
  const sockets = new Set<Socket>();
  const state: MockPostgres = { port: 0, tlsStartups: 0, plaintextStartups: 0, sslRequests: 0, queries: [], close: async () => undefined };

  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    if ('plaintext' in mode) {
      serveProtocol(sock, state, false);
      return;
    }
    sock.once('data', (first: Buffer) => {
      const isSslRequest = first.length >= 8 && first.readInt32BE(0) === 8 && first.readInt32BE(4) === SSL_REQUEST_CODE;
      if (!isSslRequest) {
        // A plaintext startup where TLS was expected: record it (the test
        // asserts this never happens) and serve it, like a lax server would.
        sock.unshift(first);
        serveProtocol(sock, state, false);
        return;
      }
      state.sslRequests += 1;
      if ('refuseTls' in mode) {
        sock.write('N');
        // A client that fell back would now send a plaintext startup message.
        serveProtocol(sock, state, false);
        return;
      }
      if ('dropAfterSslRequest' in mode) {
        sock.write('S', () => sock.destroy());
        return;
      }
      sock.write('S');
      const tlsSock = new TLSSocket(sock, {
        isServer: true,
        key: readFileSync(path.join(TLS_DIR, `${mode.tls}.key`)),
        cert: readFileSync(path.join(TLS_DIR, `${mode.tls}.pem`)),
      });
      tlsSock.on('error', () => sock.destroy());
      serveProtocol(tlsSock, state, true);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.port = (server.address() as AddressInfo).port;
  state.close = () => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((r) => server.close(() => r()));
  };
  return state;
}
