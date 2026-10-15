import { homedir } from 'node:os';
import path from 'node:path';
import { defaultConfigDir, defaultStateDir } from './config-paths';

describe('config-paths — OS-appropriate default directories (Phase 1, Windows path corrected in Phase 2)', () => {
  it('Windows: config dir is %ProgramData%\\DPDP Gateway\\config — machine-wide, not per-user', () => {
    const dir = defaultConfigDir('win32', { ProgramData: 'C:\\ProgramData' });
    expect(dir).toBe(path.join('C:\\ProgramData', 'DPDP Gateway', 'config'));
  });

  it('Windows: state dir is %ProgramData%\\DPDP Gateway\\state — a SIBLING of config, not nested inside it', () => {
    const configDir = defaultConfigDir('win32', { ProgramData: 'C:\\ProgramData' });
    const stateDir = defaultStateDir('win32', { ProgramData: 'C:\\ProgramData' });
    expect(stateDir).not.toBe(configDir);
    expect(stateDir).toBe(path.join('C:\\ProgramData', 'DPDP Gateway', 'state'));
    expect(configDir.startsWith(stateDir)).toBe(false);
    expect(stateDir.startsWith(configDir)).toBe(false);
  });

  it('Windows: falls back to C:\\ProgramData when %ProgramData% is unset', () => {
    expect(defaultConfigDir('win32', {})).toBe(path.join('C:\\ProgramData', 'DPDP Gateway', 'config'));
    expect(defaultStateDir('win32', {})).toBe(path.join('C:\\ProgramData', 'DPDP Gateway', 'state'));
  });

  it('Windows: the service account and the interactive wizard user resolve to the SAME path (the whole point of %ProgramData%)', () => {
    // Two different accounts' environments both carry %ProgramData% pointing
    // at the same machine-wide location (unlike %APPDATA%, which differs per
    // account) — this is exactly the property the service/wizard hand-off
    // depends on.
    const serviceAccountEnv = { ProgramData: 'C:\\ProgramData' };
    const interactiveUserEnv = { ProgramData: 'C:\\ProgramData' };
    expect(defaultStateDir('win32', serviceAccountEnv)).toBe(defaultStateDir('win32', interactiveUserEnv));
  });

  it('Linux: config dir honors XDG_CONFIG_HOME, state dir honors XDG_STATE_HOME', () => {
    const configDir = defaultConfigDir('linux', { XDG_CONFIG_HOME: '/home/test/.config' });
    expect(configDir).toBe(path.join('/home/test/.config', 'dpdp-gateway'));
    const stateDir = defaultStateDir('linux', { XDG_STATE_HOME: '/home/test/.local/state' });
    expect(stateDir).toBe(path.join('/home/test/.local/state', 'dpdp-gateway'));
  });

  it('Linux: falls back to ~/.config and ~/.local/state when XDG vars are unset', () => {
    const home = homedir();
    expect(defaultConfigDir('linux', {})).toBe(path.join(home, '.config', 'dpdp-gateway'));
    expect(defaultStateDir('linux', {})).toBe(path.join(home, '.local', 'state', 'dpdp-gateway'));
  });

  it('config dir and state dir are always different paths, on every platform', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(defaultConfigDir(platform, {})).not.toBe(defaultStateDir(platform, {}));
    }
  });
});
