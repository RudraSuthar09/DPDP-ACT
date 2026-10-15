/**
 * Windows DPAPI primitives (CurrentUser scope), shared by the two logically
 * separate secret stores: the device credential (credential-store-windows.ts)
 * and source connection secrets (source-secrets.ts). Each store owns its own
 * file, format and lifecycle; only these two calls are shared.
 *
 * Shells out to powershell.exe's ConvertTo-/ConvertFrom-SecureString, the
 * documented .NET wrapper over CryptProtectData/CryptUnprotectData, so the
 * agent keeps zero native (node-gyp) dependencies.
 *
 * Data NEVER travels on the command line: both scripts below are constants,
 * and the plaintext/ciphertext is written to the child's stdin (base64, so
 * PowerShell 5.1's console code page cannot mangle non-ASCII characters).
 * Command lines are visible to process-listing tools and to Windows
 * process-creation auditing (event 4688); stdin is not.
 *
 * CurrentUser scope binds the blob to the identity that ran protect(). For
 * the installed product that is ALWAYS the service's own virtual account
 * (NT SERVICE\DPDPGatewayAgent): only the service encrypts or decrypts, never
 * the Gateway Setup wizard or its elevated helper, which run as a different
 * (and, with over-the-shoulder UAC, possibly a third) Windows account.
 */
import { spawnSync } from 'node:child_process';

export class DpapiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DpapiError';
  }
}

export interface PowerShellResult {
  stdout: string;
  ok: boolean;
}

/** Injectable so unit tests never spawn powershell.exe. `input` is written
 *  to the child's stdin and must never be placed in `script`. */
export type PowerShellRunner = (script: string, input: string) => PowerShellResult;

export const PROTECT_SCRIPT = `# dpapi:protect
$b64 = [Console]::In.ReadToEnd().Trim()
$plain = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
ConvertFrom-SecureString -SecureString $secure
`;

export const UNPROTECT_SCRIPT = `# dpapi:unprotect
$cipher = [Console]::In.ReadToEnd().Trim()
$secure = ConvertTo-SecureString -String $cipher
$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
try {
  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr)
}
[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($plain))
`;

export function runPowerShellReal(script: string, input: string): PowerShellResult {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  // stderr is deliberately dropped: on a malformed-input failure it can echo
  // fragments of what was being processed.
  return { stdout: result.stdout ?? '', ok: result.status === 0 && !result.error };
}

/** ConvertFrom-SecureString emits lowercase hex; anything else is not ours. */
const CIPHERTEXT_PATTERN = /^[0-9a-fA-F]+$/;

export function isDpapiPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

export function dpapiProtect(plaintext: string, run: PowerShellRunner = runPowerShellReal): string {
  const result = run(PROTECT_SCRIPT, Buffer.from(plaintext, 'utf8').toString('base64'));
  const out = result.stdout.trim();
  if (!result.ok || !CIPHERTEXT_PATTERN.test(out)) {
    throw new DpapiError('Windows DPAPI encryption failed.');
  }
  return out;
}

export function dpapiUnprotect(ciphertext: string, run: PowerShellRunner = runPowerShellReal): string {
  if (!CIPHERTEXT_PATTERN.test(ciphertext)) {
    throw new DpapiError('Stored DPAPI data is malformed.');
  }
  const result = run(UNPROTECT_SCRIPT, ciphertext);
  const out = result.stdout.trim();
  if (!result.ok || !out) {
    throw new DpapiError(
      'Windows DPAPI decryption failed. The data was most likely encrypted under a different Windows ' +
        'account than the one running now (for the installed service: NT SERVICE\\DPDPGatewayAgent).',
    );
  }
  return Buffer.from(out, 'base64').toString('utf8');
}

/** Round-trips a fixed, non-secret value. Lets the service report at startup
 *  that DPAPI works under its own identity, instead of failing later on the
 *  first real credential write. */
export function dpapiSelfTest(run: PowerShellRunner = runPowerShellReal): boolean {
  try {
    return dpapiUnprotect(dpapiProtect('dpdp-gateway-dpapi-self-test', run), run) === 'dpdp-gateway-dpapi-self-test';
  } catch {
    return false;
  }
}
