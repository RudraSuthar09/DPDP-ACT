/**
 * The ONE integration point between the existing, untouched, pure env-only
 * `loadAgentConfig` (config.ts) and the new file-based pieces this phase
 * adds (config-file.ts, config-paths.ts). `config.ts` never learns a file
 * exists — this module reads the file (if any), merges it UNDER explicit
 * env vars (config-file.ts's `mergeFileConfigIntoEnv`), fills in the
 * OS-appropriate state-dir default when NEITHER env nor file named one, and
 * only then calls the real, already-tested `loadAgentConfig`.
 *
 * `GATEWAY_CONFIG_PATH` overrides where the config file is read from — set
 * by an installer/service wrapper that knows exactly where it put it;
 * defaults to the OS-conventional location (config-paths.ts) otherwise.
 */
import path from 'node:path';
import { loadAgentConfig, type AgentConfig } from './config';
import { loadConfigFile, mergeFileConfigIntoEnv, type AgentFileConfig, type LogLevel } from './config-file';
import { defaultConfigDir, defaultStateDir } from './config-paths';

export interface ResolvedAgentConfig {
  config: AgentConfig;
  /** Where the config file was looked for (even if none existed there). */
  configFilePath: string;
  /** null if no config file was found — not an error, see config-file.ts. */
  fileConfig: AgentFileConfig | null;
  /** From the file's `logLevel`, if set — config.ts's AgentConfig has no
   *  such field (logging is orthogonal to network config), so this is
   *  surfaced separately for index.ts to pass to createLogger(). */
  logLevel: LogLevel | null;
}

export function resolveAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  nodePlatform: NodeJS.Platform = process.platform,
): ResolvedAgentConfig {
  const configFilePath = (env.GATEWAY_CONFIG_PATH?.trim() || path.join(defaultConfigDir(nodePlatform, env), 'config.json'));
  const fileConfig = loadConfigFile(configFilePath);

  let mergedEnv = mergeFileConfigIntoEnv(env, fileConfig);

  // Neither an explicit env var NOR the config file named a state dir —
  // fall back to the OS-conventional location rather than config.ts's own
  // internal default (~/.dpdp-gateway, a Phase-3B placeholder never meant
  // to be a real install's final answer). Docker is unaffected either way:
  // it always sets GATEWAY_STATE_DIR explicitly.
  if (!mergedEnv.GATEWAY_STATE_DIR) {
    mergedEnv = { ...mergedEnv, GATEWAY_STATE_DIR: defaultStateDir(nodePlatform, env) };
  }

  const config = loadAgentConfig(mergedEnv, nodePlatform);
  return { config, configFilePath, fileConfig, logLevel: fileConfig?.logLevel ?? null };
}
