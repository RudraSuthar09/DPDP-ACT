// Builds the ONE PowerShell command this app ever runs: a non-elevated
// powershell.exe that asks Windows (UAC) to start elevated-helper.ps1 with a
// fixed action and the path of a request file. No Electron dependency, so the
// quoting and exit-code mapping are tested directly against real PowerShell
// (elevated-command.test.js).
//
// What it can NOT do, by construction:
//   - run any script other than the helper path main.js resolved itself;
//   - run any action outside ACTIONS;
//   - carry a secret: the only data argument is a temp-file PATH whose name
//     must match REQUEST_FILE_PATTERN (the helper enforces the same pattern).
'use strict';

const path = require('node:path');

const ACTIONS = Object.freeze(['pair', 'add-source', 'remove', 'restart']);
const REQUEST_FILE_PATTERN = /^dpdp-gw-request-[0-9a-f]{32}\.json$/;

/** Windows' ERROR_CANCELLED: the user declined the UAC prompt. */
const EXIT_UAC_CANCELLED = 1223;
/** Start-Process failed for any other reason (helper missing, policy...). */
const EXIT_LAUNCH_FAILED = 2;

/** PowerShell single-quoted literals are fully literal; the only special
 *  character is ' itself, escaped by doubling. */
function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildArgumentListLiteral(args) {
  return `@(${args.map(quotePowerShellSingle).join(',')})`;
}

function buildElevatedCommand(helperScriptPath, action, requestFilePath) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown elevated action: ${String(action)}`);
  if (!path.isAbsolute(helperScriptPath) || path.basename(helperScriptPath) !== 'elevated-helper.ps1') {
    throw new Error('Refusing to elevate anything other than elevated-helper.ps1.');
  }
  if (!path.isAbsolute(requestFilePath) || !REQUEST_FILE_PATTERN.test(path.basename(requestFilePath))) {
    throw new Error('Invalid request file path.');
  }
  const innerArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperScriptPath, '-Action', action, '-RequestFile', requestFilePath];
  // Start-Process THROWS when the user declines UAC (it does not return an
  // exit code), so the cancellation is detected from the exception's
  // Win32 error code.
  return (
    `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${buildArgumentListLiteral(innerArgs)} -Verb RunAs -Wait -PassThru } ` +
    `catch { $e = $_.Exception; while ($e -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }; ` +
    `if ($e -and $e.NativeErrorCode -eq ${EXIT_UAC_CANCELLED}) { exit ${EXIT_UAC_CANCELLED} }; exit ${EXIT_LAUNCH_FAILED} }; ` +
    `exit $p.ExitCode`
  );
}

module.exports = {
  ACTIONS,
  REQUEST_FILE_PATTERN,
  EXIT_UAC_CANCELLED,
  EXIT_LAUNCH_FAILED,
  quotePowerShellSingle,
  buildArgumentListLiteral,
  buildElevatedCommand,
};
