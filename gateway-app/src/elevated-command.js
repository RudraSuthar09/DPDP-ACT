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

const ACTIONS = Object.freeze(['pair', 'add-source', 'authorize-folder', 'remove', 'restart']);
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

/**
 * Quotes one argument for a Windows command line (the CommandLineToArgvW
 * rules powershell.exe uses to split its own arguments): wrap in double
 * quotes when needed, escape embedded quotes, and double the backslashes
 * that precede a quote or the closing quote.
 */
function quoteWindowsArg(value) {
  const s = String(value);
  if (s.length > 0 && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * The -ArgumentList for Start-Process, as ONE string. Windows PowerShell 5.1
 * joins an ARRAY -ArgumentList with spaces WITHOUT quoting the elements, so
 * the helper path "C:\Program Files\DPDP Gateway\elevated-helper.ps1" reached
 * the elevated powershell.exe as "-File C:\Program Files\..." and it exited
 * -196608 (0xFFFD0000, "invalid command line") before the helper ran.
 */
function buildArgumentString(args) {
  return quotePowerShellSingle(args.map(quoteWindowsArg).join(' '));
}

/** PowerShell's own exit code for a command line it cannot parse (e.g. a
 *  -File path that does not exist): -196608, seen unsigned as 4294770688. */
const EXIT_POWERSHELL_BAD_COMMAND_LINE = -196608;

/**
 * A sanitized, customer-readable message for a helper run that ended WITHOUT
 * writing its own result (so it never reached its own error handling), plus a
 * stable reference for support. Contains no paths, codes or user input.
 */
function describeHelperExit(code) {
  const signed = typeof code === 'number' ? code | 0 : null;
  const ref = signed === null ? 'none' : `0x${(signed >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  if (signed === EXIT_POWERSHELL_BAD_COMMAND_LINE) {
    return `Windows granted permission, but the Gateway setup helper could not be started (PowerShell rejected its start-up command). Reinstall DPDP Gateway, then try again. Reference: GW-HELPER-START ${ref}.`;
  }
  if (signed === EXIT_LAUNCH_FAILED) {
    return `The Gateway setup helper could not be launched. Reinstall DPDP Gateway, then try again. Reference: GW-HELPER-LAUNCH ${ref}.`;
  }
  return `The Gateway setup helper stopped without reporting a result. Try again; if it keeps happening, reinstall DPDP Gateway. Reference: GW-HELPER-EXIT ${ref}.`;
}

function buildElevatedCommand(helperScriptPath, action, requestFilePath) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown elevated action: ${String(action)}`);
  if (!path.isAbsolute(helperScriptPath) || path.basename(helperScriptPath) !== 'elevated-helper.ps1') {
    throw new Error('Refusing to elevate anything other than elevated-helper.ps1.');
  }
  if (!path.isAbsolute(requestFilePath) || !REQUEST_FILE_PATTERN.test(path.basename(requestFilePath))) {
    throw new Error('Invalid request file path.');
  }
  // -NonInteractive: the helper reads a request file and writes a result file;
  // it never prompts. Saying so means an unexpected prompt fails fast instead
  // of waiting forever behind a hidden window.
  const innerArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperScriptPath,
    '-Action',
    action,
    '-RequestFile',
    requestFilePath,
  ];
  // -WindowStyle Hidden: the ELEVATED process is a new console process, so
  // Electron's own windowsHide does not cover it — without this, approving a
  // folder flashed a PowerShell window that stayed for as long as the service
  // restart took. Elevation itself is unchanged: -Verb RunAs still raises the
  // UAC prompt, which is deliberately NOT suppressed.
  //
  // Start-Process THROWS when the user declines UAC (it does not return an
  // exit code), so the cancellation is detected from the exception's
  // Win32 error code.
  return (
    `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${buildArgumentString(innerArgs)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru } ` +
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
  EXIT_POWERSHELL_BAD_COMMAND_LINE,
  quotePowerShellSingle,
  buildArgumentListLiteral,
  quoteWindowsArg,
  buildArgumentString,
  describeHelperExit,
  buildElevatedCommand,
};
