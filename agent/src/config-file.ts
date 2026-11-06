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
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write';
import { isValidBindHost, isExactOrigin, AgentConfigError } from './config';
import { parseNoProxy, parseProxyUrl, type FileProxyConfig } from './network-config';
import { parseCaBundle } from './tls-trust';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface FileTlsConfig {
  /** PEM bundle of extra CAs. Relative paths resolve against the config
   *  file's directory, and the file must be inside that directory. */
  extraCaCertsFile?: string;
  useWindowsCertificateStore?: boolean;
}

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
  /** Outbound proxy for agent -> DPDP calls (network-config.ts). Unlike the
   *  fields above, this one takes precedence over environment variables. */
  proxy?: FileProxyConfig;
  tls?: FileTlsConfig;
}

const MAX_CA_FILE_BYTES = 1024 * 1024;

/**
 * Reads and validates tls.extraCaCertsFile. The file must live inside the
 * config file's own directory (after resolving symlinks/junctions): on an
 * installed Gateway that directory is writable only by Administrators, and a
 * trust anchor that a standard user could replace would let them intercept
 * the device token. Error messages do not echo the path.
 */
export function loadCaBundleFile(configFilePath: string, caFile: string, label = '"tls.extraCaCertsFile" in config.json'): string[] {
  const configDir = path.dirname(path.resolve(configFilePath));
  const candidate = path.resolve(configDir, caFile);
  let realDir: string;
  let realFile: string;
  try {
    realDir = realpathSync(configDir);
    realFile = realpathSync(candidate);
  } catch {
    throw new AgentConfigError(`${label} names a file that does not exist or cannot be read.`);
  }
  const rel = path.relative(realDir, realFile);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AgentConfigError(`${label} must name a file inside the Gateway config directory (the folder that holds config.json).`);
  }
  const st = statSync(realFile);
  if (!st.isFile()) throw new AgentConfigError(`${label} must name a file.`);
  if (st.size > MAX_CA_FILE_BYTES) throw new AgentConfigError(`${label} is larger than 1 MiB; supply only the CA certificates needed.`);
  return parseCaBundle(readFileSync(realFile, 'utf8'), label);
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
    // Tolerate a UTF-8 BOM: Windows PowerShell 5.1 (Set-Content -Encoding
    // UTF8) and older Notepad versions write one when an admin edits the file.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
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

  // Atomic: a crash mid-write must not leave a half-written config.json that
  // stops the service from starting.
  writeFileAtomic(filePath, serialized);
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
  if (obj.proxy !== undefined) result.proxy = validateProxy(obj.proxy, filePath);
  if (obj.tls !== undefined) result.tls = validateTls(obj.tls, filePath);

  return result;
}

function validateProxy(value: unknown, filePath: string): FileProxyConfig {
  if (value === 'none') return 'none';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentConfigError(`"proxy" in ${filePath} must be "none" or an object like {"url": "http://proxy.example:8080"}.`);
  }
  const p = value as Record<string, unknown>;
  const unknownKeys = Object.keys(p).filter((k) => k !== 'url' && k !== 'noProxy');
  if (unknownKeys.length) {
    throw new AgentConfigError(`"proxy" in ${filePath} has unsupported field(s): ${unknownKeys.join(', ')}. Allowed: url, noProxy.`);
  }
  if (typeof p.url !== 'string' || !p.url.trim()) {
    throw new AgentConfigError(`"proxy.url" in ${filePath} must be a non-empty string.`);
  }
  parseProxyUrl(p.url, { label: `"proxy.url" in ${filePath}`, allowCredentials: false });
  const result: { url: string; noProxy?: string[] } = { url: p.url.trim() };
  if (p.noProxy !== undefined) {
    if (!Array.isArray(p.noProxy) || !p.noProxy.every((e) => typeof e === 'string')) {
      throw new AgentConfigError(`"proxy.noProxy" in ${filePath} must be an array of strings.`);
    }
    parseNoProxy(p.noProxy as string[], `"proxy.noProxy" in ${filePath}`);
    result.noProxy = p.noProxy as string[];
  }
  return result;
}

function validateTls(value: unknown, filePath: string): FileTlsConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentConfigError(`"tls" in ${filePath} must be an object.`);
  }
  const t = value as Record<string, unknown>;
  const unknownKeys = Object.keys(t).filter((k) => k !== 'extraCaCertsFile' && k !== 'useWindowsCertificateStore');
  if (unknownKeys.length) {
    // Deliberately strict: a misspelt option, or an attempt at something like
    // "rejectUnauthorized", must fail loudly rather than be ignored.
    throw new AgentConfigError(
      `"tls" in ${filePath} has unsupported field(s): ${unknownKeys.join(', ')}. Allowed: extraCaCertsFile, useWindowsCertificateStore. ` +
        'Certificate verification cannot be disabled.',
    );
  }
  const result: FileTlsConfig = {};
  if (t.extraCaCertsFile !== undefined) result.extraCaCertsFile = requireString(t, 'extraCaCertsFile', filePath);
  if (t.useWindowsCertificateStore !== undefined) {
    if (typeof t.useWindowsCertificateStore !== 'boolean') {
      throw new AgentConfigError(`"tls.useWindowsCertificateStore" in ${filePath} must be true or false.`);
    }
    result.useWindowsCertificateStore = t.useWindowsCertificateStore;
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
