import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  GATEWAY_READ_DEFAULT_LIMIT,
  GATEWAY_READ_MAX_LIMIT,
  type DataConnector,
  type DataSourceKind,
  type GatewayCreateColumnResponse,
  type GatewayCreateCustomerResponse,
  type GatewayErrorCode,
  type GatewayHealthResponse,
  type GatewayReadOptions,
  type GatewayResolveCustomerResponse,
  type GatewaySourceDiscoverResponse,
  type GatewaySourceFieldsResponse,
  type GatewaySourceMetadataResponse,
  type GatewaySourceReadResponse,
  type GatewaySourceSearchResponse,
  type GatewayWriteCustomerFieldsResponse,
  type NewCustomerColumnType,
  type ResourceHandle,
} from '@dpdp/shared';
import { AGENT_VERSION } from '../version';
import { isApprovedFile, resolveWithinRoots } from './path-safety';
import { MAX_ROWS, parseCsv, parseXlsx } from './parsers';

/** A connector error carrying a stable, value-free GatewayErrorCode. */
export class ConnectorError extends Error {
  constructor(public readonly code: GatewayErrorCode) {
    super(code);
    this.name = 'ConnectorError';
  }
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_DISCOVER = 500;
const MAX_WALK_DEPTH = 4;

/**
 * FilesystemConnector — reads CSV/XLSX files under explicitly allowed roots and
 * serves them through the source-agnostic DataConnector interface. Handles are
 * OPAQUE (random ids the browser cannot forge into a path); the connector
 * resolves a handle to a real path internally and RE-VALIDATES it against the
 * allowed roots on every use, so security never rests on the handle map alone.
 *
 * It reads nothing outside its roots, opens nothing but .csv/.xlsx, loads no file
 * larger than the cap, and returns only bounded row batches. Raw rows live in
 * memory for the request only — never persisted, never logged, never sent onward.
 */
export class FilesystemConnector implements DataConnector {
  readonly sourceKind: DataSourceKind;
  private readonly roots: readonly string[];
  private readonly handleToPath = new Map<string, string>();
  private readonly pathToHandle = new Map<string, string>();

  constructor(sourceKind: DataSourceKind, roots: readonly string[]) {
    this.sourceKind = sourceKind;
    this.roots = roots;
  }

  async healthCheck(): Promise<GatewayHealthResponse> {
    // Reachable iff at least one configured root is a directory.
    const ok = this.roots.some((r) => {
      try {
        return statSync(r).isDirectory();
      } catch {
        return false;
      }
    });
    if (!ok) throw new ConnectorError('SOURCE_NOT_AUTHORIZED');
    return { status: 'ok', agentVersion: AGENT_VERSION };
  }

  private issueHandle(absPath: string): string {
    const existing = this.pathToHandle.get(absPath);
    if (existing) return existing;
    const handle = randomUUID();
    this.handleToPath.set(handle, absPath);
    this.pathToHandle.set(absPath, handle);
    return handle;
  }

  private walk(): { path: string; size: number }[] {
    const out: { path: string; size: number }[] = [];
    const visit = (dir: string, depth: number): void => {
      if (out.length >= MAX_DISCOVER || depth > MAX_WALK_DEPTH) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_DISCOVER) break;
        if (entry.name.startsWith('.')) continue; // skip hidden/system
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full, depth + 1);
        } else if (entry.isFile() && isApprovedFile(entry.name)) {
          try {
            out.push({ path: full, size: statSync(full).size });
          } catch {
            /* unreadable entry — skip */
          }
        }
      }
    };
    for (const root of this.roots) visit(root, 0);
    return out;
  }

  private toHandle(file: { path: string; size: number }): ResourceHandle {
    return {
      handle: this.issueHandle(file.path),
      descriptor: {
        resourceKind: 'file',
        label: basename(file.path),
        sizeBytes: file.size,
        estimatedRowCount: null,
      },
    };
  }

  async discover(): Promise<GatewaySourceDiscoverResponse> {
    const files = this.walk();
    return {
      sourceId: '', // filled in by the data-plane handler (it knows the source id)
      capabilities: ['discover', 'search', 'read', 'metadata', 'healthCheck'],
      handles: files.slice(0, MAX_DISCOVER).map((f) => this.toHandle(f)),
      truncated: files.length >= MAX_DISCOVER,
    };
  }

  async search(term: string, opts: GatewayReadOptions = {}): Promise<GatewaySourceSearchResponse> {
    const q = term.trim().toLowerCase();
    const all = this.walk().filter((f) => basename(f.path).toLowerCase().includes(q));
    const start = Number(opts.cursor ?? 0) || 0;
    const limit = clampLimit(opts.limit);
    const page = all.slice(start, start + limit);
    return {
      handles: page.map((f) => this.toHandle(f)),
      nextCursor: start + limit < all.length ? String(start + limit) : null,
      truncated: all.length > start + limit,
    };
  }

  /** Resolve an opaque handle to a re-validated real path (fail closed). */
  private resolve(handle: string): string {
    const path = this.handleToPath.get(handle);
    if (!path) throw new ConnectorError('FILE_NOT_FOUND'); // invalid/unknown handle
    // Re-validate on every use — the handle map is not the only line of defence.
    return resolveWithinRoots(path, this.roots);
  }

  async metadata(handle: string): Promise<GatewaySourceMetadataResponse> {
    const real = this.resolve(handle);
    const size = statSync(real).size;
    return { resourceKind: 'file', sizeBytes: size, estimatedRowCount: null };
  }

  /**
   * Phase 3G-1: the header row only — STRUCTURE, never a data row. `maxRows: 0`
   * makes the parser return an empty `rows` array; only `headers` is read. A
   * CSV/XLSX header carries no declared type, so every field reports 'text' —
   * this is a header list, not a schema-inference engine.
   */
  async listFields(handle: string): Promise<GatewaySourceFieldsResponse> {
    const real = this.resolve(handle);
    const buffer = readFileSync(real);
    const parsed = extname(real).toLowerCase() === '.xlsx' ? parseXlsx(buffer, 0) : parseCsv(buffer, 0);
    return { fields: parsed.headers.map((name) => ({ name, type: 'text', nullable: true })) };
  }

  async read(handle: string, opts: GatewayReadOptions = {}): Promise<GatewaySourceReadResponse> {
    const real = this.resolve(handle);
    const size = statSync(real).size;
    if (size > MAX_FILE_BYTES) throw new ConnectorError('RATE_LIMITED'); // too large — bounded

    const buffer = readFileSync(real);
    const parsed = extname(real).toLowerCase() === '.xlsx' ? parseXlsx(buffer, MAX_ROWS) : parseCsv(buffer, MAX_ROWS);

    const start = Number(opts.cursor ?? 0) || 0;
    const limit = clampLimit(opts.limit);
    const page = parsed.rows.slice(start, start + limit);
    const more = start + limit < parsed.rows.length;
    return {
      headers: parsed.headers,
      rows: page,
      nextCursor: more ? String(start + limit) : null,
      truncated: parsed.truncated || more,
    };
  }

  // ===========================================================================
  // Phase 3G-2 — customer resolution, controlled write/create, column creation.
  //
  // Unsupported for CSV/XLSX in this phase: none of these can be safely
  // performed on a flat file without a full rewrite of it, which is out of
  // scope here (see the createColumn requirement: "do NOT attempt to modify
  // the file schema automatically... clearly tell the client the column must
  // be added externally"). Every one fails closed with the same honest code,
  // rather than silently rewriting a customer's file.
  // ===========================================================================

  async resolveCustomer(_handle: string, _identityValue: string): Promise<GatewayResolveCustomerResponse> {
    throw new ConnectorError('UNSUPPORTED_SOURCE');
  }

  async writeCustomerFields(_customerRef: string, _fields: Record<string, string>): Promise<GatewayWriteCustomerFieldsResponse> {
    throw new ConnectorError('UNSUPPORTED_SOURCE');
  }

  async createCustomer(_handle: string, _identityValue: string, _fields: Record<string, string>): Promise<GatewayCreateCustomerResponse> {
    throw new ConnectorError('UNSUPPORTED_SOURCE');
  }

  async createColumn(_handle: string, _columnName: string, _columnType: NewCustomerColumnType): Promise<GatewayCreateColumnResponse> {
    throw new ConnectorError('UNSUPPORTED_SOURCE');
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit || limit < 1) return GATEWAY_READ_DEFAULT_LIMIT;
  return Math.min(limit, GATEWAY_READ_MAX_LIMIT);
}
