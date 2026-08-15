import type { DataConnector, DataSourceKind } from '@dpdp/shared';
import { ConnectorError, FilesystemConnector } from './filesystem-connector';
import { DatabaseConnector } from './db/database-connector';
import { dialectFor } from './db/dialect';
import { realDbClientFactory, type DbClientFactory, type DbConnection } from './db/db-client';

/**
 * Agent-local configuration of a source: which connector kind serves it, and
 * either the allowed filesystem roots (file kinds) OR the database connection
 * settings (db kinds). Set by the operator during the one-time integration, from
 * local config/env — NEVER a path/credential the browser sends, and NEVER tied to
 * a specific network address. Database CREDENTIALS live only here, inside the
 * Gateway (customer environment); they never leave it.
 */
export interface GatewaySourceConfig {
  sourceId: string;
  kind: DataSourceKind;
  roots?: string[];
  connection?: DbConnection;
  /**
   * Phase 3G-2: customer resolve/write/create configuration — entirely
   * agent-local, set by the operator, never sent by the browser and never
   * fetched from the central platform.
   */
  identityColumn?: string;
  allowCustomerCreate?: boolean;
  /** The explicit allowlist of columns writeCustomerFields/createCustomer may
   *  touch. Nothing outside this list is ever written, regardless of what a
   *  request asks for. */
  writableColumns?: string[];
  /** A SEPARATE, privileged credential for writes/schema changes. Absent means
   *  every write/create/column-create operation fails closed. */
  writeConnection?: DbConnection;
}

const FILE_KINDS = new Set<DataSourceKind>(['csv', 'excel', 'filesystem']);
const DB_KINDS = new Set<DataSourceKind>(['postgresql', 'mysql', 'sqlserver']);

/**
 * Maps a sourceId to its DataConnector. One connector instance per source
 * (cached, so opaque handles issued during discover survive to a later read).
 * The registry is the ONLY place that knows "which connector serves this source",
 * so a new connector kind is added here and nowhere else.
 */
export class ConnectorRegistry {
  private readonly cache = new Map<string, DataConnector>();

  /** `dbClientFactory` is injectable so tests can drive DB connectors without a
   *  live database; production uses the real driver-backed factory. */
  constructor(
    private readonly sources: readonly GatewaySourceConfig[],
    private readonly dbClientFactory: DbClientFactory = realDbClientFactory,
  ) {}

  /** Fail closed: an unconfigured source has no connector. */
  get(sourceId: string): DataConnector {
    const cfg = this.sources.find((s) => s.sourceId === sourceId);
    if (!cfg) throw new ConnectorError('SOURCE_NOT_AUTHORIZED');
    let connector = this.cache.get(sourceId);
    if (!connector) {
      connector = createConnector(cfg, this.dbClientFactory);
      this.cache.set(sourceId, connector);
    }
    return connector;
  }
}

function createConnector(cfg: GatewaySourceConfig, dbClientFactory: DbClientFactory): DataConnector {
  if (FILE_KINDS.has(cfg.kind)) {
    if (!cfg.roots || cfg.roots.length === 0) throw new ConnectorError('SOURCE_NOT_AUTHORIZED');
    return new FilesystemConnector(cfg.kind, cfg.roots);
  }
  if (DB_KINDS.has(cfg.kind)) {
    const dialect = dialectFor(cfg.kind);
    if (!dialect || !cfg.connection) throw new ConnectorError('SOURCE_NOT_AUTHORIZED');
    const conn = cfg.connection;
    const writeConn = cfg.writeConnection;
    return new DatabaseConnector(dialect, () => dbClientFactory(cfg.kind, conn), {
      identityColumn: cfg.identityColumn,
      allowCustomerCreate: cfg.allowCustomerCreate,
      writableColumns: cfg.writableColumns,
      // A SEPARATE credential — never falls back to the read-only connection.
      makeWriteClient: writeConn ? () => dbClientFactory(cfg.kind, writeConn) : undefined,
    });
  }
  // Oracle / MongoDB / ERP / CRM etc. are not implemented — fail closed. Adding
  // one is a new dialect + client here; the browser and central platform never change.
  throw new ConnectorError('UNSUPPORTED_SOURCE');
}

/** Parse agent source config from an env var (JSON). Network-agnostic; the
 *  operator supplies sourceId/kind/roots. Empty if unset. */
export function loadSourceConfig(env: NodeJS.ProcessEnv = process.env): GatewaySourceConfig[] {
  const raw = env.GATEWAY_SOURCES?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GATEWAY_SOURCES must be valid JSON: [{ "sourceId", "kind", "roots": [] }].');
  }
  if (!Array.isArray(parsed)) throw new Error('GATEWAY_SOURCES must be a JSON array.');
  return parsed.map((entry) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.sourceId !== 'string' || typeof e.kind !== 'string') {
      throw new Error('Each GATEWAY_SOURCES entry needs { sourceId, kind }.');
    }
    const kind = e.kind as DataSourceKind;
    const cfg: GatewaySourceConfig = { sourceId: e.sourceId, kind };
    if (Array.isArray(e.roots)) cfg.roots = e.roots.map(String);
    // DB connection settings live locally, in this config, only. Never logged,
    // never sent to the browser or Azure.
    if (e.connection && typeof e.connection === 'object') {
      cfg.connection = parseConnection(e.connection as Record<string, unknown>);
    }
    // Phase 3G-2: identity/writable-column/creation config + the SEPARATE
    // privileged write credential — all agent-local, all optional.
    if (typeof e.identityColumn === 'string') cfg.identityColumn = e.identityColumn;
    if (e.allowCustomerCreate !== undefined) cfg.allowCustomerCreate = Boolean(e.allowCustomerCreate);
    if (Array.isArray(e.writableColumns)) cfg.writableColumns = e.writableColumns.map(String);
    if (e.writeConnection && typeof e.writeConnection === 'object') {
      cfg.writeConnection = parseConnection(e.writeConnection as Record<string, unknown>);
    }
    return cfg;
  });
}

function parseConnection(c: Record<string, unknown>): DbConnection {
  return {
    host: String(c.host ?? ''),
    port: Number(c.port ?? 0),
    user: String(c.user ?? ''),
    password: String(c.password ?? ''),
    database: String(c.database ?? ''),
    ...(c.ssl !== undefined ? { ssl: Boolean(c.ssl) } : {}),
  };
}
