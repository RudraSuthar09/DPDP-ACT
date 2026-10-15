import { DpapiError, PROTECT_SCRIPT, UNPROTECT_SCRIPT, dpapiProtect, dpapiSelfTest, dpapiUnprotect, type PowerShellRunner } from './dpapi';

describe('dpapi primitives (MOCKED runner)', () => {
  it('passes data only via stdin; the script is always one of two fixed constants', () => {
    const calls: Array<{ script: string; input: string }> = [];
    const run: PowerShellRunner = (script, input) => {
      calls.push({ script, input });
      return script === PROTECT_SCRIPT ? { stdout: 'abcdef0123\r\n', ok: true } : { stdout: Buffer.from('hello').toString('base64'), ok: true };
    };
    expect(dpapiProtect('hello', run)).toBe('abcdef0123');
    expect(dpapiUnprotect('abcdef0123', run)).toBe('hello');
    expect(calls.map((c) => c.script)).toEqual([PROTECT_SCRIPT, UNPROTECT_SCRIPT]);
    expect(calls[0]!.input).toBe(Buffer.from('hello').toString('base64'));
  });

  it('rejects non-hex output from protect (never stores something it cannot round-trip)', () => {
    expect(() => dpapiProtect('x', () => ({ stdout: 'Exception: boom', ok: true }))).toThrow(DpapiError);
  });

  it('rejects non-hex ciphertext before spawning anything', () => {
    let spawned = false;
    expect(() =>
      dpapiUnprotect("00'; Start-Process calc; '", () => {
        spawned = true;
        return { stdout: '', ok: true };
      }),
    ).toThrow(/malformed/);
    expect(spawned).toBe(false);
  });

  it('a failed decrypt explains the identity mismatch without echoing data', () => {
    try {
      dpapiUnprotect('abcdef', () => ({ stdout: '', ok: false }));
      throw new Error('expected DpapiError');
    } catch (err) {
      expect(err).toBeInstanceOf(DpapiError);
      expect((err as Error).message).toMatch(/different Windows account/);
      expect((err as Error).message).not.toContain('abcdef');
    }
  });

  it('self-test reports false when the runner fails', () => {
    expect(dpapiSelfTest(() => ({ stdout: '', ok: false }))).toBe(false);
  });
});

const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('dpapi primitives with REAL Windows DPAPI (powershell.exe, this test account)', () => {
  it('round-trips non-ASCII, quotes, newlines and an empty-ish value', () => {
    for (const value of ['pässwörd-日本', `it's "quoted"\nnext line`, ' ']) {
      expect(dpapiUnprotect(dpapiProtect(value))).toBe(value);
    }
  }, 180_000);

  it('produces a different ciphertext each time for the same plaintext (salted)', () => {
    expect(dpapiProtect('same')).not.toBe(dpapiProtect('same'));
  }, 180_000);

  it('self-test passes under this account', () => {
    expect(dpapiSelfTest()).toBe(true);
  }, 180_000);
});
