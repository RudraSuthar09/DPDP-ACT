// Where things live, derived from this process's own location -- never from
// command-line arguments (which any caller could set). No Electron
// dependency; tested by paths.test.js and config-path.test.js.
'use strict';

const path = require('node:path');

/**
 * Installed layout (Inno Setup):  {app}\gateway-app\electron\electron.exe
 *                                 {app}\elevated-helper.ps1  (Program Files: admin-only)
 * Anything else is a development checkout, where elevated actions are not
 * available (there is no installed runtime for the helper to use).
 */
function resolveInstallLayout(execPath = process.execPath, appSrcDir = __dirname) {
  const exeDir = path.dirname(execPath);
  const isInstalled =
    path.basename(exeDir).toLowerCase() === 'electron' && path.basename(path.dirname(exeDir)).toLowerCase() === 'gateway-app';
  if (isInstalled) {
    const installRoot = path.dirname(path.dirname(exeDir));
    return { installed: true, installRoot, helperPath: path.join(installRoot, 'elevated-helper.ps1') };
  }
  return {
    installed: false,
    installRoot: null,
    helperPath: path.resolve(appSrcDir, '..', '..', 'gateway-installer', 'service', 'elevated-helper.ps1'),
  };
}

/** Mirrors agent/src/config-paths.ts's Windows defaultConfigDir() --
 *  config-path.test.js checks it against the agent's compiled module. */
function defaultConfigFilePath(env = process.env) {
  const base = (env.ProgramData && env.ProgramData.trim()) || 'C:\\ProgramData';
  return path.join(base, 'DPDP Gateway', 'config', 'config.json');
}

module.exports = { resolveInstallLayout, defaultConfigFilePath };
