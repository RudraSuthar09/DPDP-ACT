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
  EXIT_POWERSHELL_BAD_COMMAND_LINE,
  EXIT_UAC_CANCELLED,
  buildArgumentListLiteral,
  buildElevatedCommand,
  describeHelperExit,
  quotePowerShellSingle,
  quoteWindowsArg,
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
  assert.deepStrictEqual([...ACTIONS], ['pair', 'add-source', 'authorize-folder', 'remove', 'restart']);
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
  assert.ok(cmd.includes('-Verb RunAs -WindowStyle Hidden -Wait -PassThru'));
  // The elevated console must never be visible to a customer.
  assert.ok(cmd.includes('-WindowStyle Hidden'));
  // ...and the helper is told it will not be prompted.
  assert.ok(cmd.includes('-NonInteractive'));
  assert.ok(cmd.includes('-Action add-source -RequestFile'));
  assert.ok(!/password|enrollment|code/i.test(cmd.replace(/NativeErrorCode|ExitCode/g, '')));
});

check('(Phase 6 root cause) -ArgumentList is ONE string with paths containing spaces quoted, never a PowerShell array', () => {
  const cmd = buildElevatedCommand(HELPER, 'pair', REQ);
  assert.ok(!/-ArgumentList @\(/.test(cmd), 'an array -ArgumentList is joined WITHOUT quoting by Windows PowerShell 5.1');
  assert.ok(cmd.includes('-File "C:\\Program Files\\DPDP Gateway\\elevated-helper.ps1"'));
});

check('quoteWindowsArg follows the Windows command-line rules', () => {
  assert.strictEqual(quoteWindowsArg('pair'), 'pair');
  assert.strictEqual(quoteWindowsArg('C:\\Program Files\\x.ps1'), '"C:\\Program Files\\x.ps1"');
  assert.strictEqual(quoteWindowsArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.strictEqual(quoteWindowsArg('a"b'), '"a\\"b"');
  assert.strictEqual(quoteWindowsArg(''), '""');
});

check('a helper that never wrote its result is reported by stage, with a reference -- never a raw unsigned exit code', () => {
  const msg = describeHelperExit(4294770688); // what Electron reported for -196608
  assert.match(msg, /could not be started/);
  assert.match(msg, /GW-HELPER-START 0xFFFD0000/);
  assert.ok(!msg.includes('4294770688'));
  assert.strictEqual(describeHelperExit(-196608), msg);
  assert.match(describeHelperExit(EXIT_LAUNCH_FAILED), /GW-HELPER-LAUNCH 0x00000002/);
  assert.match(describeHelperExit(9), /GW-HELPER-EXIT 0x00000009/);
  assert.match(describeHelperExit(null), /GW-HELPER-EXIT none/);
  assert.strictEqual(EXIT_POWERSHELL_BAD_COMMAND_LINE >>> 0, 4294770688);
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

checkWin('REAL PowerShell: Start-Process receives the verb and one quoted argument string', () => {
  const r = runPowerShell(
    'function Start-Process { param($FilePath, $ArgumentList, $Verb, $WindowStyle, [switch]$Wait, [switch]$PassThru) ' +
      "[Console]::Out.WriteLine(\"$FilePath|$Verb|$($ArgumentList.GetType().Name)|$ArgumentList\"); [pscustomobject]@{ ExitCode = 0 } }\n" +
      buildElevatedCommand(HELPER, 'pair', REQ),
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(
    r.stdout.trim().split(/\r?\n/)[0],
    `powershell.exe|RunAs|String|-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${HELPER}" -Action pair -RequestFile ${REQ}`,
  );
});

// The regression test for the real failure ("The setup step failed (exit code
// 4294770688)"): the REAL Start-Process (not a stand-in) starting a REAL
// helper whose path contains spaces, through the same node spawn main.js
// uses. Only "-Verb RunAs" is removed -- a test cannot answer a UAC prompt --
// so this does NOT exercise elevation itself.
checkWin('REAL Start-Process: a helper under a path WITH SPACES runs and receives the exact arguments (was exit -196608)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdp gw helper '));
  try {
    const helper = path.join(dir, 'Program Files', 'DPDP Gateway', 'elevated-helper.ps1');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    const out = path.join(dir, 'received.txt');
    fs.writeFileSync(
      helper,
      `param([string]$Action, [string]$RequestFile)\r\nSet-Content -LiteralPath '${out.replace(/'/g, "''")}' -Value ($Action + '|' + $RequestFile) -Encoding UTF8\r\nexit 0\r\n`,
    );
    const reqDir = path.join(dir, "O'Brien temp");
    fs.mkdirSync(reqDir);
    const req = path.join(reqDir, 'dpdp-gw-request-0123456789abcdef0123456789abcdef.json');

    const cmd = buildElevatedCommand(helper, 'pair', req);
    assert.ok(cmd.includes(' -Verb RunAs '));
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd.replace(' -Verb RunAs ', ' ')], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    assert.strictEqual(r.status, 0, `exit ${r.status} (${(r.status >>> 0).toString(16)}): ${r.stderr}`);
    assert.strictEqual(fs.readFileSync(out, 'utf8').replace(/^﻿/, '').trim(), `pair|${req}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

checkWin('REAL Start-Process: the OLD array form really fails with -196608 for such a path (proves the test detects the bug)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdp gw old '));
  try {
    const helper = path.join(dir, 'elevated-helper.ps1');
    fs.writeFileSync(helper, 'exit 0\r\n');
    const oldForm = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${buildArgumentListLiteral(['-NoProfile', '-File', helper])} -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', oldForm], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.strictEqual(r.status >>> 0, 4294770688);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed`);
