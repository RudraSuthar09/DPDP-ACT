import type { DataSourceKind, NewCustomerColumnType } from '@dpdp/shared';

/**
 * The ONLY per-database difference: how to list tables, page a bounded read, and
 * quote an identifier. Everything else (handles, limits, auth, masking) is shared
 * by one DatabaseConnector. Identifiers passed to readSql come exclusively from
 * the Gateway's own discovery allow-list — never from the browser — and are still
 * quote-escaped here. Row VALUES are always bound parameters, never interpolated,
 * so there is no SQL-injection surface.
 *
 * Phase 3G-2 adds the customer resolve/write/create + controlled column-creation
 * builders. Same rule: identifiers (schema/table/column names) come from the
 * Gateway's own validated/authorized state, quote-escaped here; every VALUE is a
 * bound parameter. `addColumnSql` is the one exception that cannot be
 * parameterized (DDL) — its inputs are validated against a strict identifier
 * regex and a small type allowlist BEFORE this is ever called (see
 * database-connector.ts), so there is still no injection surface.
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
  /** List columns (name, data type, nullable) of one authorized table — STRUCTURE
   *  ONLY, from information_schema, values parameterized. Never a row. */
  listColumnsSql(schema: string, table: string): SqlText;
  /** The table's primary-key column name, from information_schema — the
   *  "minimum internal row identifier" a customerRef is built from. Returns no
   *  rows if the table has no primary key (the caller must fail safely, never
   *  guess a column called "id"). */
  primaryKeySql(schema: string, table: string): SqlText;
  /** Find one row by the (Gateway-configured) identity column, parameterized. */
  resolveCustomerSql(schema: string, table: string, pkColumn: string, identityColumn: string, identityValue: string): SqlText;
  /** Update explicitly-mapped columns of one row by primary key, parameterized. */
  updateCustomerSql(schema: string, table: string, pkColumn: string, pkValue: string, columns: string[], values: string[]): SqlText;
  /** Insert a new row from explicitly-mapped columns, parameterized. */
  insertCustomerSql(schema: string, table: string, columns: string[], values: string[]): SqlText;
  /** The controlled ALTER TABLE ADD COLUMN. `sqlType` is the dialect's NATIVE
   *  type string for an already-allowlisted NewCustomerColumnType — never a
   *  caller-supplied type string. Not parameterizable (DDL); both `columnName`
   *  and the type mapping are validated/allowlisted before this runs. */
  addColumnSql(schema: string, table: string, columnName: string, sqlType: string): SqlText;
  /** Map an allowlisted canonical type to this dialect's native column type. */
  nativeColumnType(type: NewCustomerColumnType): string;
}

// --- PostgreSQL -------------------------------------------------------------

function pgQuote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

const PG_TYPES: Record<NewCustomerColumnType, string> = {
  text: 'text',
  integer: 'integer',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
};

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
  listColumnsSql: (schema, table) => ({
    sql:
      'SELECT column_name, data_type, is_nullable FROM information_schema.columns ' +
      'WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
    params: [schema, table],
  }),
  // NOTE: deliberately NOT information_schema.table_constraints/key_column_usage
  // — PostgreSQL only exposes rows there to a role holding a privilege OTHER
  // THAN SELECT on the table (documented Postgres behaviour). A genuinely
  // least-privilege, SELECT-only read credential would see ZERO rows and this
  // would silently misreport "no primary key". pg_catalog (pg_index/
  // pg_attribute/pg_class) has no such restriction — it is readable with a
  // plain SELECT-only role, which is exactly the credential this runs under.
  primaryKeySql: (schema, table) => ({
    sql:
      'SELECT a.attname AS column_name ' +
      'FROM pg_index i ' +
      'JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) ' +
      'JOIN pg_class t ON t.oid = i.indrelid ' +
      'JOIN pg_namespace n ON n.oid = t.relnamespace ' +
      'WHERE n.nspname = $1 AND t.relname = $2 AND i.indisprimary ' +
      'ORDER BY array_position(i.indkey, a.attnum) LIMIT 1',
    params: [schema, table],
  }),
  resolveCustomerSql: (schema, table, pkColumn, identityColumn, identityValue) => ({
    sql: `SELECT ${pgQuote(pkColumn)} FROM ${pgQuote(schema)}.${pgQuote(table)} WHERE ${pgQuote(identityColumn)} = $1 LIMIT 1`,
    params: [identityValue],
  }),
  updateCustomerSql: (schema, table, pkColumn, pkValue, columns, values) => ({
    sql:
      `UPDATE ${pgQuote(schema)}.${pgQuote(table)} SET ` +
      columns.map((c, i) => `${pgQuote(c)} = $${i + 1}`).join(', ') +
      ` WHERE ${pgQuote(pkColumn)} = $${columns.length + 1}`,
    params: [...values, pkValue],
  }),
  insertCustomerSql: (schema, table, columns, values) => ({
    sql:
      `INSERT INTO ${pgQuote(schema)}.${pgQuote(table)} (${columns.map(pgQuote).join(', ')}) ` +
      `VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    params: values,
  }),
  addColumnSql: (schema, table, columnName, sqlType) => ({
    sql: `ALTER TABLE ${pgQuote(schema)}.${pgQuote(table)} ADD COLUMN ${pgQuote(columnName)} ${sqlType}`,
    params: [],
  }),
  nativeColumnType: (type) => PG_TYPES[type],
};

// --- MySQL ------------------------------------------------------------------

function myQuote(ident: string): string {
  return `\`${ident.replace(/`/g, '``')}\``;
}

const MYSQL_TYPES: Record<NewCustomerColumnType, string> = {
  text: 'text',
  integer: 'int',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
};

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
  listColumnsSql: (schema, table) => ({
    sql:
      'SELECT column_name, data_type, is_nullable FROM information_schema.columns ' +
      'WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
    params: [schema, table],
  }),
  primaryKeySql: (schema, table) => ({
    sql:
      'SELECT kcu.column_name FROM information_schema.table_constraints tc ' +
      'JOIN information_schema.key_column_usage kcu ' +
      '  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name ' +
      "WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = ? AND tc.table_name = ? " +
      'ORDER BY kcu.ordinal_position LIMIT 1',
    params: [schema, table],
  }),
  resolveCustomerSql: (schema, table, pkColumn, identityColumn, identityValue) => ({
    sql: `SELECT ${myQuote(pkColumn)} FROM ${myQuote(schema)}.${myQuote(table)} WHERE ${myQuote(identityColumn)} = ? LIMIT 1`,
    params: [identityValue],
  }),
  updateCustomerSql: (schema, table, pkColumn, pkValue, columns, values) => ({
    sql:
      `UPDATE ${myQuote(schema)}.${myQuote(table)} SET ` +
      columns.map((c) => `${myQuote(c)} = ?`).join(', ') +
      ` WHERE ${myQuote(pkColumn)} = ?`,
    params: [...values, pkValue],
  }),
  insertCustomerSql: (schema, table, columns, values) => ({
    sql:
      `INSERT INTO ${myQuote(schema)}.${myQuote(table)} (${columns.map(myQuote).join(', ')}) ` +
      `VALUES (${columns.map(() => '?').join(', ')})`,
    params: values,
  }),
  addColumnSql: (schema, table, columnName, sqlType) => ({
    sql: `ALTER TABLE ${myQuote(schema)}.${myQuote(table)} ADD COLUMN ${myQuote(columnName)} ${sqlType}`,
    params: [],
  }),
  nativeColumnType: (type) => MYSQL_TYPES[type],
};

// --- SQL Server -------------------------------------------------------------

function msQuote(ident: string): string {
  return `[${ident.replace(/]/g, ']]')}]`;
}

const MSSQL_TYPES: Record<NewCustomerColumnType, string> = {
  text: 'nvarchar(max)',
  integer: 'int',
  boolean: 'bit',
  date: 'date',
  datetime: 'datetime2',
};

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
  listColumnsSql: (schema, table) => ({
    sql:
      'SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS ' +
      'WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2 ORDER BY ORDINAL_POSITION',
    params: [schema, table],
  }),
  primaryKeySql: (schema, table) => ({
    sql:
      'SELECT kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ' +
      'JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ' +
      '  ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA AND kcu.TABLE_NAME = tc.TABLE_NAME ' +
      "WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @p1 AND tc.TABLE_NAME = @p2 " +
      'ORDER BY kcu.ORDINAL_POSITION OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY',
    params: [schema, table],
  }),
  resolveCustomerSql: (schema, table, pkColumn, identityColumn, identityValue) => ({
    sql:
      `SELECT ${msQuote(pkColumn)} FROM ${msQuote(schema)}.${msQuote(table)} ` +
      `WHERE ${msQuote(identityColumn)} = @p1 ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY`,
    params: [identityValue],
  }),
  updateCustomerSql: (schema, table, pkColumn, pkValue, columns, values) => ({
    sql:
      `UPDATE ${msQuote(schema)}.${msQuote(table)} SET ` +
      columns.map((c, i) => `${msQuote(c)} = @p${i + 1}`).join(', ') +
      ` WHERE ${msQuote(pkColumn)} = @p${columns.length + 1}`,
    params: [...values, pkValue],
  }),
  insertCustomerSql: (schema, table, columns, values) => ({
    sql:
      `INSERT INTO ${msQuote(schema)}.${msQuote(table)} (${columns.map(msQuote).join(', ')}) ` +
      `VALUES (${columns.map((_, i) => `@p${i + 1}`).join(', ')})`,
    params: values,
  }),
  addColumnSql: (schema, table, columnName, sqlType) => ({
    sql: `ALTER TABLE ${msQuote(schema)}.${msQuote(table)} ADD ${msQuote(columnName)} ${sqlType}`,
    params: [],
  }),
  nativeColumnType: (type) => MSSQL_TYPES[type],
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
