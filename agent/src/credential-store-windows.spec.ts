import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDpapiCredentialStore, DpapiError, type PowerShellRunner } from './credential-store-windows';
import { PROTECT_SCRIPT, UNPROTECT_SCRIPT } from './dpapi';
import type { PersistedCredential } from './enrollment';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-dpapi-test-'));
}

const SAMPLE: PersistedCredential = {
  tenantId: 'tenant-1',
  deviceId: 'device-1',
  deviceToken: 'super-secret-device-token-value',
  enrolledAt: '2026-01-01T00:00:00.000Z',
};

/** MOCKED DPAPI (no powershell.exe): protect hex-encodes the base64 input it
 *  was given on stdin; unprotect reverses it. Same stdin/stdout contract as
 *  the real scripts, so envelope, JSON and corruption handling are exercised
 *  for real — only the cryptography is fake. */
function fakeRunner(): PowerShellRunner {
  return (script: string, input: string) => {
    if (script.startsWith('# dpapi:protect')) {
      return { stdout: Buffer.from(input, 'utf8').toString('hex'), ok: true };
    }
    return { stdout: Buffer.from(input, 'hex').toString('utf8'), ok: true };
  };
}

function failingRunner(): PowerShellRunner {
  return () => ({ stdout: '', ok: false });
}

describe('createDpapiCredentialStore — Windows DPAPI-backed CredentialStore (mocked shellout)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('load() returns null when no credential file exists yet', () => {
    const store = createDpapiCredentialStore(dir, fakeRunner());
    expect(store.load()).toBeNull();
  });

  it('save() then load() round-trips the credential exactly', () => {
    const store = createDpapiCredentialStore(dir, fakeRunner());
    store.save(SAMPLE);
    expect(store.load()).toEqual(SAMPLE);
  });

  it('the file on disk is an envelope — it never contains the plaintext device token', () => {
    const store = createDpapiCredentialStore(dir, fakeRunner());
    store.save(SAMPLE);
    const raw = readFileSync(path.join(dir, 'device-credential.json'), 'utf8');
    expect(raw).not.toContain(SAMPLE.deviceToken);
    const parsed = JSON.parse(raw) as { dpapi: string };
    expect(typeof parsed.dpapi).toBe('string');
  });

  it('clear() removes the credential file', () => {
    const store = createDpapiCredentialStore(dir, fakeRunner());
    store.save(SAMPLE);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('a plaintext (non-DPAPI-envelope) file is treated as corrupt, not silently accepted', () => {
    writeFileSync(path.join(dir, 'device-credential.json'), JSON.stringify(SAMPLE));
    const store = createDpapiCredentialStore(dir, fakeRunner());
    expect(() => store.load()).toThrow(/not a DPAPI envelope/);
  });

  it('save() throws DpapiError when the encryption shellout fails', () => {
    const store = createDpapiCredentialStore(dir, failingRunner());
    expect(() => store.save(SAMPLE)).toThrow(DpapiError);
  });

  it('load() throws DpapiError when the decryption shellout fails (e.g. wrong account/service identity)', () => {
    const store = createDpapiCredentialStore(dir, fakeRunner());
    store.save(SAMPLE);
    const failingStore = createDpapiCredentialStore(dir, failingRunner());
    expect(() => failingStore.load()).toThrow(DpapiError);
  });

  it('never puts data on the powershell.exe command line — scripts are fixed constants, data goes via stdin', () => {
    const scripts: string[] = [];
    const capturing: PowerShellRunner = (script, input) => {
      scripts.push(script);
      return fakeRunner()(script, input);
    };
    const store = createDpapiCredentialStore(dir, capturing);
    store.save(SAMPLE);
    store.load();
    expect(scripts).toEqual([PROTECT_SCRIPT, UNPROTECT_SCRIPT]);
    const b64Token = Buffer.from(SAMPLE.deviceToken).toString('base64');
    for (const s of scripts) {
      expect(s).not.toContain(SAMPLE.deviceToken);
      expect(s).not.toContain(b64Token);
    }
  });

  it('refuses to hand a non-hex ciphertext to PowerShell (a crafted file cannot inject script)', () => {
    writeFileSync(path.join(dir, 'device-credential.json'), JSON.stringify({ dpapi: "abc'; Remove-Item C:\\x; '" }));
    let invoked = false;
    const store = createDpapiCredentialStore(dir, (s, i) => {
      invoked = true;
      return fakeRunner()(s, i);
    });
    expect(() => store.load()).toThrow(/malformed/);
    expect(invoked).toBe(false);
  });

  it('save() leaves no temp files behind in the state directory', () => {
    const store = createDpapiCredentialStore(dir, fakeRunner());
    store.save(SAMPLE);
    store.save({ ...SAMPLE, deviceToken: 'rotated' });
    expect(readdirSync(dir)).toEqual(['device-credential.json']);
  });
});

// ---------------------------------------------------------------------------
// REAL DPAPI integration test — actually shells out to powershell.exe on
// this machine. Skipped outside win32 (DPAPI does not exist elsewhere) and
// requires no admin rights: DPAPI's CurrentUser scope works for any logged-
// in account, which is exactly what this test runs as.
// ---------------------------------------------------------------------------
const describeWindowsOnly = process.platform === 'win32' ? describe : describe.skip;

describeWindowsOnly('createDpapiCredentialStore — REAL Windows DPAPI (live powershell.exe, no mocks)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a real credential through actual CryptProtectData/CryptUnprotectData', () => {
    const store = createDpapiCredentialStore(dir); // real runner — no injected mock
    store.save(SAMPLE);
    const raw = readFileSync(path.join(dir, 'device-credential.json'), 'utf8');
    // The ciphertext on disk must not contain the plaintext token in any form.
    expect(raw).not.toContain(SAMPLE.deviceToken);
    expect(store.load()).toEqual(SAMPLE);
  }, 180_000);

  it('a token containing quotes/special characters still round-trips correctly', () => {
    const tricky: PersistedCredential = { ...SAMPLE, deviceToken: `o'brien$\${weird}"token\nwith-newline` };
    const store = createDpapiCredentialStore(dir);
    store.save(tricky);
    expect(store.load()).toEqual(tricky);
  }, 180_000);
});
