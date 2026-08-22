import type { StorageConnector } from '@dpdp/shared';
import { GatewayStorageProvider } from './gateway-storage-provider';

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

  constructor(private readonly roots: readonly GatewayStorageRootConfig[]) {}

  get(storageRootId: string): StorageConnector {
    const cfg = this.roots.find((r) => r.storageRootId === storageRootId);
    if (!cfg) throw new StorageNotConfiguredError();
    let provider = this.cache.get(storageRootId);
    if (!provider) {
      provider = new GatewayStorageProvider(cfg.rootPath);
      this.cache.set(storageRootId, provider);
    }
    return provider;
  }
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
