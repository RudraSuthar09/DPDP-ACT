// Plain-node test: `node src/elevated-command.test.js`. The "REAL PowerShell"
// checks run actual powershell.exe (Windows only); no UAC prompt is ever
// raised -- Start-Process is shadowed by a PowerShell function, which takes
// precedence over the cmdlet.
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const {
  ACTIONS,
  EXIT_LAUNCH_FAILED,
  EXIT_UAC_CANCELLED,
  buildArgumentListLiteral,
  buildElevatedCommand,
  quotePowerShellSingle,
} = require('./elevated-command');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const isWindows = process.platform === 'win32';
const checkWin = isWindows ? check : (name) => console.log(`  skip (not win32): ${name}`);

const HELPER = 'C:\\Program Files\\DPDP Gateway\\elevated-helper.ps1';
const REQ = 'C:\\Users\\u\\AppData\\Local\\Temp\\dpdp-gw-request-0123456789abcdef0123456789abcdef.json';

check('quotePowerShellSingle doubles embedded quotes', () => {
  assert.strictEqual(quotePowerShellSingle("o'brien"), "'o''brien'");
});

check('only the four known actions can be elevated', () => {
  assert.deepStrictEqual([...ACTIONS], ['pair', 'add-source', 'remove', 'restart']);
  for (const bad of ['shell', 'pair; calc', '', undefined, 'PAIR']) {
    assert.throws(() => buildElevatedCommand(HELPER, bad, REQ), /Unknown elevated action/);
  }
});

check('refuses to elevate any script other than elevated-helper.ps1, or a relative path', () => {
  assert.throws(() => buildElevatedCommand('C:\\evil\\payload.ps1', 'pair', REQ), /elevated-helper/);
  assert.throws(() => buildElevatedCommand('elevated-helper.ps1', 'pair', REQ), /elevated-helper/);
  assert.throws(() => buildElevatedCommand('C:\\x\\elevated-helper.ps1.exe', 'pair', REQ), /elevated-helper/);
});

check('the request path must be absolute and match the strict request-file name', () => {
  for (const bad of ['dpdp-gw-request-0123456789abcdef0123456789abcdef.json', 'C:\\x\\notes.txt', 'C:\\x\\dpdp-gw-request-XYZ.json', "C:\\x\\dpdp-gw-request-0123456789abcdef0123456789abcdef.json'; calc"]) {
    assert.throws(() => buildElevatedCommand(HELPER, 'pair', bad), /request file/);
  }
});

check('the generated command carries no data beyond fixed flags, the helper path and the request path', () => {
  const cmd = buildElevatedCommand(HELPER, 'add-source', REQ);
  assert.ok(cmd.includes('-Verb RunAs -Wait -PassThru'));
  assert.ok(cmd.includes("'-Action','add-source','-RequestFile'"));
  assert.ok(!/password|enrollment|code/i.test(cmd.replace(/NativeErrorCode|ExitCode/g, '')));
});

function runPowerShell(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
}

function roundTrip(value) {
  const literal = buildArgumentListLiteral(['-File', 'C:\\fake.ps1', '-Payload', value]);
  const r = runPowerShell(`$myArgs = ${literal}\nforeach ($a in $myArgs) { Write-Output $a }`);
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
}

checkWin('REAL PowerShell: a quote, semicolon+cmdlet, $() and backticks all stay one inert literal', () => {
  for (const value of ["o'brien", "x'; Write-Output 'INJECTED'; '", '$(Write-Output INJECTED)', 'a`nb`0c']) {
    const lines = roundTrip(value);
    assert.ok(!lines.includes('INJECTED'), `injection executed for ${value}: ${JSON.stringify(lines)}`);
    assert.strictEqual(lines[lines.length - 1], value);
  }
});

checkWin(`REAL PowerShell: declining UAC (Win32Exception 1223, wrapped like Start-Process does) exits ${EXIT_UAC_CANCELLED}`, () => {
  const shadow =
    'function Start-Process { throw (New-Object System.InvalidOperationException("This command cannot be run due to the error: The operation was canceled by the user.", (New-Object System.ComponentModel.Win32Exception 1223))) }\n';
  const r = runPowerShell(shadow + buildElevatedCommand(HELPER, 'pair', REQ));
  assert.strictEqual(r.status, EXIT_UAC_CANCELLED);
});

checkWin(`REAL PowerShell: any other launch failure exits ${EXIT_LAUNCH_FAILED}`, () => {
  const r = runPowerShell("function Start-Process { throw 'helper missing' }\n" + buildElevatedCommand(HELPER, 'pair', REQ));
  assert.strictEqual(r.status, EXIT_LAUNCH_FAILED);
});

checkWin('REAL PowerShell: the elevated helper\'s own exit code is passed through', () => {
  const r = runPowerShell('function Start-Process { [pscustomobject]@{ ExitCode = 7 } }\n' + buildElevatedCommand(HELPER, 'restart', REQ));
  assert.strictEqual(r.status, 7);
});

checkWin('REAL PowerShell: Start-Process receives exactly the expected argument list', () => {
  const r = runPowerShell(
    'function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru) ' +
      "[Console]::Out.WriteLine(\"$FilePath|$Verb|$($ArgumentList -join '|')\"); [pscustomobject]@{ ExitCode = 0 } }\n" +
      buildElevatedCommand(HELPER, 'pair', REQ),
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(
    r.stdout.trim().split(/\r?\n/)[0],
    `powershell.exe|RunAs|-NoProfile|-ExecutionPolicy|Bypass|-File|${HELPER}|-Action|pair|-RequestFile|${REQ}`,
  );
});

console.log(`\n${passed} passed`);
