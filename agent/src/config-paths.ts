/**
 * OS-appropriate default directories for the agent's two kinds of local
 * state, kept DELIBERATELY SEPARATE (Phase 1 of the production build-out):
 *
 *   - CONFIG dir: ordinary, non-secret settings (config.json — control-plane
 *     URL, bind address, log level, display name, ...). Fine to back up,
 *     fine to read for troubleshooting.
 *   - STATE dir: secrets (device-credential.json, sources.json — the latter
 *     carries database passwords for Phase 3D/3E connectors). Same location
 *     `enrollment.ts` has always used for the device credential; this file
 *     only adds where it lives BY DEFAULT on a real OS, not what goes in it.
 *
 * Pure, synchronous, no I/O — mirrors config.ts's own discipline. Every
 * existing GATEWAY_STATE_DIR / GATEWAY_CONFIG_PATH env var still wins over
 * these defaults; nothing here changes behavior for a deployment that
 * already sets GATEWAY_STATE_DIR explicitly (Docker always does).
 *
 * WINDOWS: %ProgramData%, not %APPDATA% (Phase 2 correction). The agent
 * runs as a Windows SERVICE under its own dedicated account (see
 * gateway-installer/service), while config.json/pending-enrollment.json are
 * WRITTEN by the Gateway Setup wizard running as whichever ordinary signed-
 * in user is doing the install — a DIFFERENT Windows account. %APPDATA% is
 * per-user; the service account's %APPDATA% and the interactive user's
 * %APPDATA% are two different directories that would never see each
 * other's files. %ProgramData% (CSIDL_COMMON_APPDATA) is the OS-documented,
 * machine-wide location for exactly this "a service and the tool that
 * configures it share state" case — see gateway-installer/service/
 * install-service.ps1 for the ACLs that make both sides able to read/write
 * their respective share of it.
 */
import os from 'node:os';
import path from 'node:path';

const APP_DIR_NAME_WINDOWS = 'DPDP Gateway';
const APP_DIR_NAME_XDG = 'dpdp-gateway';

/** Windows: %ProgramData%\DPDP Gateway\config. Linux/other: $XDG_CONFIG_HOME
 *  (or ~/.config)/dpdp-gateway — the XDG Base Directory spec, the
 *  conventional home for a Linux background service's own settings. */
export function defaultConfigDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const base = env.ProgramData?.trim() || 'C:\\ProgramData';
    return path.join(base, APP_DIR_NAME_WINDOWS, 'config');
  }
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, APP_DIR_NAME_XDG);
}

/** Windows: %ProgramData%\DPDP Gateway\state. Linux/other: $XDG_STATE_HOME
 *  (or ~/.local/state)/dpdp-gateway — the XDG convention for persistent,
 *  non-config, non-cache state. A SIBLING of the config dir on Windows
 *  (both directly under %ProgramData%\DPDP Gateway), not nested inside it —
 *  they get DIFFERENT ACLs at install time (state is locked to the service
 *  account + Administrators; config is writable by ordinary signed-in
 *  users too), and a parent/child relationship would make that harder to
 *  express correctly. */
export function defaultStateDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const base = env.ProgramData?.trim() || 'C:\\ProgramData';
    return path.join(base, APP_DIR_NAME_WINDOWS, 'state');
  }
  const base = env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.local', 'state');
  return path.join(base, APP_DIR_NAME_XDG);
}
