/**
 * File-based agent configuration (Phase 1 of the production build-out).
 *
 * WHY: a background OS service has no developer shell to inject
 * GATEWAY_* environment variables into — `config.ts`'s existing env-only
 * contract is exactly right for Docker/dev/CI, and stays completely
 * unchanged (see config.ts's own header), but a real installed client needs
 * a FILE an installer/wizard can write instead. This module adds that file,
 * validated the same way config.ts validates env vars — hand-written and
 * total, same discipline, not a second configuration philosophy.
 *
 * ONLY ordinary, non-secret settings belong in this file. Device credentials
 * live in device-credential.json (enrollment.ts, unchanged) and database
 * connection secrets live in sources-file.ts's sources.json — both in the
 * STATE directory, never this CONFIG file (see config-paths.ts's header for
 * why the two directories are kept separate).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isValidBindHost, isExactOrigin, AgentConfigError } from './config';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Every field optional — a file supplying only `controlPlaneUrl` is valid;
 *  anything it omits falls back to config.ts's existing env/default chain. */
export interface AgentFileConfig {
  controlPlaneUrl?: string;
  stateDir?: string;
  displayName?: string;
  heartbeatIntervalSeconds?: number;
  bindHost?: string;
  bindPort?: number;
  allowedOrigins?: string[];
  logLevel?: LogLevel;
}

/**
 * Reads and validates the config file at `filePath`. Returns `null` if the
 * file simply doesn't exist yet (a fresh install with no config.json is not
 * an error — every field falls back to config.ts's defaults). Throws
 * AgentConfigError — same type config.ts itself throws, same "never
 * contains a secret" discipline — for anything else: unreadable, invalid
 * JSON, or a field that fails validation. A background service with a typo
 * in its config file needs a startup error it can actually act on, not a
 * silent fallback to defaults that masks the typo.
 */
export function loadConfigFile(filePath: string): AgentFileConfig | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AgentConfigError(`Could not read the Gateway config file at ${filePath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentConfigError(`The Gateway config file at ${filePath} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentConfigError(`The Gateway config file at ${filePath} must be a JSON object.`);
  }

  return validateObject(parsed as Record<string, unknown>, filePath);
}

/**
 * Writes a validated config file (Phase 2 of the production build-out) —
 * the setup wizard's counterpart to `loadConfigFile`, not a new schema.
 * Runs the SAME validation this module already enforces on read, so a
 * wizard bug can never write a config.json the agent would then reject at
 * next startup; the wizard finds out immediately instead. Creates the
 * parent directory if needed (a fresh install has none yet).
 */
export function writeConfigFile(filePath: string, config: AgentFileConfig): void {
  // Round-trip through the reader's own validator by writing to a throwaway
  // string first — reuses the exact same field-by-field rules rather than a
  // second, divergent copy of them.
  const serialized = JSON.stringify(config, null, 2);
  const reparsed = JSON.parse(serialized) as Record<string, unknown>;
  validateObject(reparsed, filePath);

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, serialized, 'utf8');
}

/** Extracted from loadConfigFile so write-time validation is the exact same
 *  code path as read-time validation — never a second implementation of
 *  "what a valid config.json field looks like". */
function validateObject(obj: Record<string, unknown>, filePath: string): AgentFileConfig {
  const result: AgentFileConfig = {};

  if (obj.controlPlaneUrl !== undefined) {
    result.controlPlaneUrl = requireString(obj, 'controlPlaneUrl', filePath);
    try {
      const u = new URL(result.controlPlaneUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      throw new AgentConfigError(`"controlPlaneUrl" in ${filePath} must be a valid http(s) URL.`);
    }
  }
  if (obj.stateDir !== undefined) result.stateDir = requireString(obj, 'stateDir', filePath);
  if (obj.displayName !== undefined) result.displayName = requireString(obj, 'displayName', filePath);
  if (obj.bindHost !== undefined) {
    result.bindHost = requireString(obj, 'bindHost', filePath);
    if (!isValidBindHost(result.bindHost)) {
      throw new AgentConfigError(`"bindHost" in ${filePath} is not a valid IP address or hostname.`);
    }
  }
  if (obj.bindPort !== undefined) {
    const n = obj.bindPort;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) {
      throw new AgentConfigError(`"bindPort" in ${filePath} must be an integer between 1 and 65535.`);
    }
    result.bindPort = n;
  }
  if (obj.heartbeatIntervalSeconds !== undefined) {
    const n = obj.heartbeatIntervalSeconds;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 5) {
      throw new AgentConfigError(`"heartbeatIntervalSeconds" in ${filePath} must be an integer of at least 5.`);
    }
    result.heartbeatIntervalSeconds = n;
  }
  if (obj.allowedOrigins !== undefined) {
    if (!Array.isArray(obj.allowedOrigins) || !obj.allowedOrigins.every((o) => typeof o === 'string')) {
      throw new AgentConfigError(`"allowedOrigins" in ${filePath} must be an array of strings.`);
    }
    for (const origin of obj.allowedOrigins as string[]) {
      if (origin.includes('*')) {
        throw new AgentConfigError(`"allowedOrigins" in ${filePath} must not contain a wildcard "*". List exact origins only.`);
      }
      if (!isExactOrigin(origin)) {
        throw new AgentConfigError(`"allowedOrigins" in ${filePath} contains an invalid origin. Each must be scheme://host[:port].`);
      }
    }
    result.allowedOrigins = obj.allowedOrigins as string[];
  }
  if (obj.logLevel !== undefined) {
    if (typeof obj.logLevel !== 'string' || !(LOG_LEVELS as readonly string[]).includes(obj.logLevel)) {
      throw new AgentConfigError(`"logLevel" in ${filePath} must be one of: ${LOG_LEVELS.join(', ')}.`);
    }
    result.logLevel = obj.logLevel as LogLevel;
  }

  return result;
}

function requireString(obj: Record<string, unknown>, field: string, filePath: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new AgentConfigError(`"${field}" in ${filePath} must be a non-empty string.`);
  }
  return v.trim();
}

/**
 * Merge file config UNDER explicit environment variables — env always wins
 * when both are present, so a developer's `$env:GATEWAY_BIND_PORT` (or a
 * controlled deployment's env-only setup) behaves exactly as it always has.
 * Returns an env-shaped object suitable for passing straight into
 * config.ts's existing, unmodified `loadAgentConfig()` — this is the ONLY
 * integration point between the two; loadAgentConfig itself never learns
 * that a file exists.
 */
export function mergeFileConfigIntoEnv(
  env: NodeJS.ProcessEnv,
  file: AgentFileConfig | null,
): NodeJS.ProcessEnv {
  if (!file) return env;
  const merged: NodeJS.ProcessEnv = { ...env };
  if (file.controlPlaneUrl !== undefined && !merged.GATEWAY_CONTROL_PLANE_URL) merged.GATEWAY_CONTROL_PLANE_URL = file.controlPlaneUrl;
  if (file.stateDir !== undefined && !merged.GATEWAY_STATE_DIR) merged.GATEWAY_STATE_DIR = file.stateDir;
  if (file.displayName !== undefined && !merged.GATEWAY_DISPLAY_NAME) merged.GATEWAY_DISPLAY_NAME = file.displayName;
  if (file.heartbeatIntervalSeconds !== undefined && !merged.GATEWAY_HEARTBEAT_INTERVAL_SECONDS) {
    merged.GATEWAY_HEARTBEAT_INTERVAL_SECONDS = String(file.heartbeatIntervalSeconds);
  }
  if (file.bindHost !== undefined && !merged.GATEWAY_BIND_HOST) merged.GATEWAY_BIND_HOST = file.bindHost;
  if (file.bindPort !== undefined && !merged.GATEWAY_BIND_PORT) merged.GATEWAY_BIND_PORT = String(file.bindPort);
  if (file.allowedOrigins !== undefined && !merged.GATEWAY_ALLOWED_ORIGINS) {
    merged.GATEWAY_ALLOWED_ORIGINS = file.allowedOrigins.join(',');
  }
  return merged;
}
