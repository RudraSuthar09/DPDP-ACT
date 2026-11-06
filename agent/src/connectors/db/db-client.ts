import type { DataSourceKind } from '@dpdp/shared';
import { ConnectorError } from '../filesystem-connector';

/**
 * The database access boundary. A DbClient runs a parameterized query with a
 * timeout and returns columns + string rows. It is INJECTED into the connector,
 * so the connector logic is testable with a fake, and the real driver wiring
 * (below) is network-agnostic — host/port/credentials come from local config.
 *
 * Credentials live ONLY here, inside the Gateway (customer environment). They are
 * never returned, never logged, and never travel to the browser or to Azure.
 */

export interface DbConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Enable TLS to the database where the customer requires it. Config-driven —
   *  never hardcoded. (This is DB-connection TLS, not the browser↔Gateway TLS.)
   *  PostgreSQL: the server certificate AND host name are verified (libpq
   *  sslmode=verify-full); there is no plaintext fallback. */
  ssl?: boolean;
  /** PostgreSQL: PEM bundle of the CA(s) that issued the database server's
   *  certificate, for private deployments. A file name relative to the Gateway
   *  config directory (and it must live there — see source-tls.ts). When set,
   *  ONLY these CAs are trusted for this connection (libpq sslrootcert). */
  sslCaFile?: string;
  /** Runtime only, never persisted: the validated PEM certificates loaded
   *  from sslCaFile at startup (source-tls.ts). */
  sslCa?: readonly string[];
}

/**
 * TLS options for the PostgreSQL driver. Verification is never relaxed: no
 * option here disables certificate or host-name checks (pg passes this object
 * to tls.connect, whose defaults verify both; pg sets `servername` for DNS
 * names, and Node checks an IP host against the certificate's IP SANs).
 * `undefined` means plaintext, used only when the source says ssl is off.
 */
export function postgresTlsOptions(conn: DbConnection): { ca?: string[] } | undefined {
  if (!conn.ssl) return undefined;
  return conn.sslCa && conn.sslCa.length > 0 ? { ca: [...conn.sslCa] } : {};
}

export interface DbQueryResult {
  columns: string[];
  rows: string[][];
}

export interface DbClient {
  query(sql: string, params: unknown[], opts: { timeoutMs: number }): Promise<DbQueryResult>;
  close(): Promise<void>;
}

export type DbClientFactory = (kind: DataSourceKind, conn: DbConnection) => DbClient;

/** Dynamic, resolution-untyped import so typecheck needs no driver @types and a
 *  file-only deployment never loads a DB driver it doesn't use. */
function loadDriver(name: string): Promise<unknown> {
  return import(name);
}

/** Reject if a query outlives its timeout — a coarse but real cancellation. */
function withTimeout<T>(p: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new ConnectorError('TIMEOUT'));
    }, timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function toStringRows(rowObjects: Record<string, unknown>[], columns: string[]): string[][] {
  return rowObjects.map((r) => columns.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))));
}

// --- real driver-backed clients (best effort; unverifiable without live DBs) --

function postgresClient(conn: DbConnection): DbClient {
  let client: { query: Function; end: Function } | null = null;
  const connect = async () => {
    const pg = (await loadDriver('pg')) as { Client: new (c: unknown) => { query: Function; end: Function; connect: Function } };
    const c = new pg.Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database, ssl: postgresTlsOptions(conn) });
    await c.connect();
    return c;
  };
  return {
    async query(sql, params, opts) {
      if (!client) client = await connect();
      const run = (async () => {
        const res = (await client!.query({ text: sql, values: params })) as { fields?: { name: string }[]; rows: Record<string, unknown>[] };
        const columns = (res.fields ?? []).map((f) => f.name);
        return { columns, rows: toStringRows(res.rows ?? [], columns) };
      })();
      return withTimeout(run, opts.timeoutMs, () => void this.close());
    },
    async close() {
      if (client) {
        try {
          await client.end();
        } catch {
          /* ignore */
        }
        client = null;
      }
    },
  };
}

function mysqlClient(conn: DbConnection): DbClient {
  let client: { execute: Function; end: Function } | null = null;
  const connect = async () => {
    const mysql = (await loadDriver('mysql2/promise')) as { createConnection: (c: unknown) => Promise<{ execute: Function; end: Function }> };
    return mysql.createConnection({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database, ssl: conn.ssl ? {} : undefined });
  };
  return {
    async query(sql, params, opts) {
      if (!client) client = await connect();
      const run = (async () => {
        const [rows, fields] = (await client!.execute(sql, params)) as [Record<string, unknown>[], { name: string }[]];
        const columns = (fields ?? []).map((f) => f.name);
        return { columns, rows: toStringRows(Array.isArray(rows) ? rows : [], columns) };
      })();
      return withTimeout(run, opts.timeoutMs, () => void this.close());
    },
    async close() {
      if (client) {
        try {
          await client.end();
        } catch {
          /* ignore */
        }
        client = null;
      }
    },
  };
}

function sqlserverClient(conn: DbConnection): DbClient {
  let pool: { request: Function; close: Function; connected?: boolean } | null = null;
  const connect = async () => {
    const mssql = (await loadDriver('mssql')) as { ConnectionPool: new (c: unknown) => { connect: Function; request: Function; close: Function } };
    const p = new mssql.ConnectionPool({
      server: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      options: { encrypt: conn.ssl !== false, trustServerCertificate: true },
    });
    await p.connect();
    return p;
  };
  return {
    async query(sql, params, opts) {
      if (!pool) pool = await connect();
      const run = (async () => {
        const request = pool!.request();
        params.forEach((v, i) => request.input(`p${i + 1}`, v));
        // mssql's recordset carries a `.columns` map; typed loosely here.
        const res = (await request.query(sql)) as { recordset?: unknown };
        const rowset = (res.recordset ?? []) as Record<string, unknown>[] & { columns?: Record<string, unknown> };
        const columns = rowset.columns ? Object.keys(rowset.columns) : Object.keys(rowset[0] ?? {});
        return { columns, rows: toStringRows([...rowset], columns) };
      })();
      return withTimeout(run, opts.timeoutMs, () => void this.close());
    },
    async close() {
      if (pool) {
        try {
          await pool.close();
        } catch {
          /* ignore */
        }
        pool = null;
      }
    },
  };
}

export const realDbClientFactory: DbClientFactory = (kind, conn) => {
  switch (kind) {
    case 'postgresql':
      return postgresClient(conn);
    case 'mysql':
      return mysqlClient(conn);
    case 'sqlserver':
      return sqlserverClient(conn);
    default:
      throw new ConnectorError('UNSUPPORTED_SOURCE');
  }
};
