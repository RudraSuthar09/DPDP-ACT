import type { DataSourceKind } from '@dpdp/shared';

/**
 * The ONLY per-database difference: how to list tables, page a bounded read, and
 * quote an identifier. Everything else (handles, limits, auth, masking) is shared
 * by one DatabaseConnector. Identifiers passed to readSql come exclusively from
 * the Gateway's own discovery allow-list — never from the browser — and are still
 * quote-escaped here. Row VALUES are always bound parameters, never interpolated,
 * so there is no SQL-injection surface.
 */

export interface SqlText {
  sql: string;
  params: unknown[];
}

export interface SqlDialect {
  readonly kind: DataSourceKind;
  /** Health probe. */
  healthSql(): string;
  /** List base tables (schema, table), bounded. */
  listTablesSql(maxTables: number): SqlText;
  /** A bounded read of one authorized table, values parameterized. */
  readSql(schema: string, table: string, limit: number, offset: number): SqlText;
}

// --- PostgreSQL -------------------------------------------------------------

function pgQuote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export const postgresDialect: SqlDialect = {
  kind: 'postgresql',
  healthSql: () => 'SELECT 1',
  listTablesSql: (maxTables) => ({
    sql:
      "SELECT table_schema, table_name FROM information_schema.tables " +
      "WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') " +
      'ORDER BY table_schema, table_name LIMIT $1',
    params: [maxTables],
  }),
  readSql: (schema, table, limit, offset) => ({
    sql: `SELECT * FROM ${pgQuote(schema)}.${pgQuote(table)} LIMIT $1 OFFSET $2`,
    params: [limit, offset],
  }),
};

// --- MySQL ------------------------------------------------------------------

function myQuote(ident: string): string {
  return `\`${ident.replace(/`/g, '``')}\``;
}

export const mysqlDialect: SqlDialect = {
  kind: 'mysql',
  healthSql: () => 'SELECT 1',
  listTablesSql: (maxTables) => ({
    sql:
      'SELECT table_schema, table_name FROM information_schema.tables ' +
      "WHERE table_type = 'BASE TABLE' " +
      "AND table_schema NOT IN ('mysql','information_schema','performance_schema','sys') " +
      'ORDER BY table_schema, table_name LIMIT ?',
    params: [maxTables],
  }),
  readSql: (schema, table, limit, offset) => ({
    sql: `SELECT * FROM ${myQuote(schema)}.${myQuote(table)} LIMIT ? OFFSET ?`,
    params: [limit, offset],
  }),
};

// --- SQL Server -------------------------------------------------------------

function msQuote(ident: string): string {
  return `[${ident.replace(/]/g, ']]')}]`;
}

export const sqlserverDialect: SqlDialect = {
  kind: 'sqlserver',
  healthSql: () => 'SELECT 1',
  listTablesSql: (maxTables) => ({
    sql:
      'SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ' +
      "WHERE TABLE_TYPE = 'BASE TABLE' " +
      'ORDER BY TABLE_SCHEMA, TABLE_NAME OFFSET 0 ROWS FETCH NEXT @p1 ROWS ONLY',
    params: [maxTables],
  }),
  readSql: (schema, table, limit, offset) => ({
    sql:
      `SELECT * FROM ${msQuote(schema)}.${msQuote(table)} ` +
      'ORDER BY (SELECT NULL) OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY',
    params: [offset, limit],
  }),
};

export function dialectFor(kind: DataSourceKind): SqlDialect | null {
  switch (kind) {
    case 'postgresql':
      return postgresDialect;
    case 'mysql':
      return mysqlDialect;
    case 'sqlserver':
      return sqlserverDialect;
    default:
      return null;
  }
}
