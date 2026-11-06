import type { StorageConnector } from '@dpdp/shared';
import { GatewayStorageProvider } from './gateway-storage-provider';
import { canWrite, type GatewaySourceConfig } from '../connectors/registry';

/** Agent-local configuration of one storage root: which storageRootId maps to
 *  which real local path on THIS machine. Set by the operator, from local
 *  config/env — never sent by the browser, never fetched from the central
 *  platform (the central side only stores the LOGICAL storage_roots row; the
 *  physical path is a Gateway-local secret-free config, same discipline as
 *  GatewaySourceConfig.roots). */
export interface GatewayStorageRootConfig {
  storageRootId: string;
  rootPath: string;
}

export class StorageNotConfiguredError extends Error {
  constructor(public readonly code: 'STORAGE_ROOT_NOT_AUTHORIZED' = 'STORAGE_ROOT_NOT_AUTHORIZED') {
    super(code);
    this.name = 'StorageNotConfiguredError';
  }
}

/**
 * Maps a storageRootId to its StorageConnector. Mirrors ConnectorRegistry's
 * shape (one instance per configured root, fail closed for anything not
 * explicitly configured).
 */
export class StorageRegistry {
  private readonly cache = new Map<string, StorageConnector>();

  /** `revoked` is consulted on EVERY lookup — see ConnectorRegistry's
   *  constructor for why. Absent = nothing revoked (tests, dev). */
  constructor(
    private readonly roots: readonly GatewayStorageRootConfig[],
    private readonly revoked: { has(id: string): boolean } = { has: () => false },
  ) {}

  get(storageRootId: string): StorageConnector {
    // Revoked beats configured: no write can land in a folder the customer
    // has removed, even if this process's local list still names it.
    if (this.revoked.has(storageRootId)) throw new StorageNotConfiguredError();
    const cfg = this.roots.find((r) => r.storageRootId === storageRootId);
    if (!cfg) throw new StorageNotConfiguredError();
    let provider = this.cache.get(storageRootId);
    if (!provider) {
      provider = new GatewayStorageProvider(cfg.rootPath);
      this.cache.set(storageRootId, provider);
    }
    return provider;
  }

  /** The storage locations this Gateway may write to — reported to DPDP when
   *  claiming deliveries, so it is only ever handed work it can perform. */
  ids(): string[] {
    // A revoked location is not offered when claiming work either, so DPDP
    // stops handing this Gateway deliveries it must refuse.
    return this.roots.filter((r) => !this.revoked.has(r.storageRootId)).map((r) => r.storageRootId);
  }
}

/** The write-authorized entries of the Manage-sources list, as storage roots.
 *  Only an explicit 'write'/'both' grant ever produces one. */
export function storageRootsFromSources(sources: readonly GatewaySourceConfig[]): GatewayStorageRootConfig[] {
  return sources
    .filter((s) => canWrite(s) && s.storageRootId && s.roots?.length === 1)
    .map((s) => ({ storageRootId: s.storageRootId!, rootPath: s.roots![0]! }));
}

/**
 * GATEWAY_STORAGE_ROOTS (Docker/dev/CI, unchanged semantics) and the
 * Manage-sources write grants (Windows Gateway Setup), combined. The env var
 * keeps working exactly as before; it is no longer the ONLY way. One storage
 * location may map to one folder only: a conflict between the two is refused
 * (the env entry is kept and the conflict is reported), never silently
 * resolved to a different folder.
 */
export function mergeStorageRoots(
  fromEnv: readonly GatewayStorageRootConfig[],
  fromSources: readonly GatewayStorageRootConfig[],
): { roots: GatewayStorageRootConfig[]; conflicts: string[] } {
  const roots = [...fromEnv];
  const conflicts: string[] = [];
  for (const r of fromSources) {
    const existing = roots.find((x) => x.storageRootId === r.storageRootId);
    if (!existing) roots.push(r);
    else if (existing.rootPath !== r.rootPath) conflicts.push(r.storageRootId);
  }
  return { roots, conflicts };
}

/** Parse agent storage-root config from an env var (JSON), mirroring
 *  connectors/registry.ts's loadSourceConfig. Empty if unset. */
export function loadStorageRootConfig(env: NodeJS.ProcessEnv = process.env): GatewayStorageRootConfig[] {
  const raw = env.GATEWAY_STORAGE_ROOTS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GATEWAY_STORAGE_ROOTS must be valid JSON: [{ "storageRootId", "rootPath" }].');
  }
  if (!Array.isArray(parsed)) throw new Error('GATEWAY_STORAGE_ROOTS must be a JSON array.');
  return parsed.map((entry) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.storageRootId !== 'string' || typeof e.rootPath !== 'string') {
      throw new Error('Each GATEWAY_STORAGE_ROOTS entry needs { storageRootId, rootPath }.');
    }
    return { storageRootId: e.storageRootId, rootPath: e.rootPath };
  });
}
