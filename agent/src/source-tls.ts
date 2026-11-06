/**
 * Database TLS trust for configured sources (PostgreSQL `sslCaFile`).
 *
 * Deliberately separate from the outbound HTTP trust in tls-trust.ts: a
 * private database CA is not a reason to trust that CA for DPDP backend
 * traffic, nor the reverse. Uses the same loader and rules as
 * tls.extraCaCertsFile (config-file.ts's loadCaBundleFile): the file must be
 * inside the Gateway config directory (admin-only on an installed Gateway, so
 * a standard user cannot plant a CA and intercept the database password) and
 * must contain only valid CA certificates.
 *
 * Runs once at startup on in-memory copies; the loaded PEM (`sslCa`) is never
 * written back to sources.json.
 */
import { loadCaBundleFile } from './config-file';
import type { GatewaySourceConfig } from './connectors/registry';
import type { DbConnection } from './connectors/db/db-client';

export interface SourceTlsResult {
  /** Sources ready for the registry. A source whose CA could not be loaded is
   *  LEFT OUT (fail closed): it is never connected without its CA. */
  sources: GatewaySourceConfig[];
  /** How many sources were left out. */
  rejected: number;
  /** Secret-free messages naming the source by position, for the log. */
  messages: string[];
}

export function resolveSourceTls(sources: readonly GatewaySourceConfig[], configFilePath: string): SourceTlsResult {
  const result: SourceTlsResult = { sources: [], rejected: 0, messages: [] };
  sources.forEach((source, index) => {
    try {
      result.sources.push({
        ...source,
        ...(source.connection ? { connection: withCa(source.connection, configFilePath) } : {}),
        ...(source.writeConnection ? { writeConnection: withCa(source.writeConnection, configFilePath) } : {}),
      });
    } catch (err) {
      result.rejected += 1;
      result.messages.push(
        `Data source #${index + 1} (${source.kind}) was not loaded: its "sslCaFile" is unusable (${err instanceof Error ? err.message : 'invalid'}). ` +
          'It stays disabled until the CA file is fixed; the Gateway never connects to it without the configured CA.',
      );
    }
  });
  return result;
}

function withCa(conn: DbConnection, configFilePath: string): DbConnection {
  if (!conn.sslCaFile) return conn;
  return { ...conn, sslCa: loadCaBundleFile(configFilePath, conn.sslCaFile, '"sslCaFile"') };
}
