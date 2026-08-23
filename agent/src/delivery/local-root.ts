/**
 * Resolves the REAL absolute local filesystem root this delivery agent
 * writes into. The cloud backend never knows or stores this path (see
 * submission-delivery.service.ts's header) — only this process, running on
 * the tenant's own machine, does.
 *
 * Two sources, tried in order:
 *   1. Electron's OWN persisted config file (enterprise-storage.json, the
 *      SAME file desktop/src/enterprise-storage.js writes) — read directly
 *      when this agent runs co-located with the installed Electron app on
 *      the same Windows machine (the real production deployment). Its
 *      location is not guessed; it must be told via ELECTRON_STORAGE_CONFIG_PATH.
 *   2. AGENT_LOCAL_STORAGE_ROOT — an explicit override/fallback, used for
 *      the Docker local-simulation test environment (where there is no real
 *      Electron userData path to read) and as a manual override otherwise.
 *
 * Re-checked on every poll tick (not cached) — so the very first "Select
 * Folder" a human does in Electron takes effect on this agent's next poll
 * with no restart required.
 */
import { readFileSync } from 'node:fs';
import { isAbsolutePath } from './local-fs-ops';

export interface LocalRootConfig {
  electronConfigPath: string | null;
  fallbackRoot: string | null;
}

export function loadLocalRootConfig(env: NodeJS.ProcessEnv = process.env): LocalRootConfig {
  return {
    electronConfigPath: env.ELECTRON_STORAGE_CONFIG_PATH?.trim() || null,
    fallbackRoot: env.AGENT_LOCAL_STORAGE_ROOT?.trim() || null,
  };
}

/** Returns the configured root, or null if nothing usable is configured yet
 *  (the agent logs this and simply waits for the next poll — not an error). */
export function resolveLocalStorageRoot(config: LocalRootConfig): string | null {
  if (config.electronConfigPath) {
    const fromElectron = readElectronConfigRootPath(config.electronConfigPath);
    if (fromElectron && isAbsolutePath(fromElectron)) return fromElectron;
  }
  if (config.fallbackRoot && isAbsolutePath(config.fallbackRoot)) return config.fallbackRoot;
  return null;
}

function readElectronConfigRootPath(configPath: string): string | null {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { enterpriseStorage?: { rootPath?: unknown } };
    const rootPath = parsed.enterpriseStorage?.rootPath;
    return typeof rootPath === 'string' && rootPath.trim() ? rootPath.trim() : null;
  } catch {
    // Not present yet, unreadable, or corrupt — treated as "not configured",
    // never a crash: the fallback (or the next poll) handles it.
    return null;
  }
}
