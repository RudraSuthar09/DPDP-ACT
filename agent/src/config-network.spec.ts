/**
 * config.json "proxy" and "tls" (Phase 4): validation, the CA-file location
 * rule, and that resolveAgentConfig reads the CA bundle at start-up.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentConfigError } from './config';
import { loadCaBundleFile, loadConfigFile } from './config-file';
import { resolveAgentConfig } from './config-resolve';

const TLS_DIR = path.join(__dirname, '__fixtures__', 'tls');

describe('config.json proxy/tls fields', () => {
  let dir: string;
  let cfg: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dpdp-cfgnet-'));
    cfg = path.join(dir, 'config.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const load = (obj: unknown): ReturnType<typeof loadConfigFile> => {
    writeFileSync(cfg, JSON.stringify(obj));
    return loadConfigFile(cfg);
  };

  it('accepts a proxy object, "none", and tls options', () => {
    expect(load({ proxy: { url: 'http://proxy.corp:8080', noProxy: ['intranet.corp', '10.0.0.0/8'] } })?.proxy).toEqual({
      url: 'http://proxy.corp:8080',
      noProxy: ['intranet.corp', '10.0.0.0/8'],
    });
    expect(load({ proxy: 'none' })?.proxy).toBe('none');
    expect(load({ tls: { extraCaCertsFile: 'corp-ca.pem', useWindowsCertificateStore: true } })?.tls).toEqual({
      extraCaCertsFile: 'corp-ca.pem',
      useWindowsCertificateStore: true,
    });
  });

  it('rejects proxy credentials in config.json (readable by every local user), without echoing them', () => {
    let err: unknown;
    try {
      load({ proxy: { url: 'http://svc:Hunter2-Secret@proxy.corp:8080' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentConfigError);
    expect((err as Error).message).toMatch(/proxy-credentials\.json/);
    expect((err as Error).message).not.toContain('Hunter2-Secret');
  });

  it.each([
    [{ proxy: 42 }, /"none" or an object/],
    [{ proxy: { url: '' } }, /non-empty string/],
    [{ proxy: { url: 'socks5://p:1080' } }, /SOCKS/],
    [{ proxy: { url: 'http://p:1', noProxy: 'a.example' } }, /array of strings/],
    [{ proxy: { url: 'http://p:1', noProxy: ['bad host!'] } }, /not a host name/],
    [{ proxy: { url: 'http://p:1', password: 'x' } }, /unsupported field/],
    [{ tls: { rejectUnauthorized: false } }, /cannot be disabled/],
    [{ tls: { useWindowsCertificateStore: 'yes' } }, /true or false/],
    [{ tls: 'on' }, /must be an object/],
  ])('rejects %j', (obj, msg) => {
    expect(() => load(obj)).toThrow(msg);
  });
});

describe('loadCaBundleFile — must live inside the config directory', () => {
  let root: string;
  let configDir: string;
  let cfg: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dpdp-cafile-'));
    configDir = path.join(root, 'config');
    mkdirSync(configDir);
    cfg = path.join(configDir, 'config.json');
    copyFileSync(path.join(TLS_DIR, 'test-ca.pem'), path.join(configDir, 'corp-ca.pem'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('loads a relative or absolute path inside the config directory', () => {
    expect(loadCaBundleFile(cfg, 'corp-ca.pem')).toHaveLength(1);
    expect(loadCaBundleFile(cfg, path.join(configDir, 'corp-ca.pem'))).toHaveLength(1);
    mkdirSync(path.join(configDir, 'certs'));
    copyFileSync(path.join(TLS_DIR, 'test-ca.pem'), path.join(configDir, 'certs', 'ca.pem'));
    expect(loadCaBundleFile(cfg, 'certs/ca.pem')).toHaveLength(1);
  });

  it('refuses a file outside the config directory (e.g. a user-writable location), without echoing the path', () => {
    copyFileSync(path.join(TLS_DIR, 'test-ca.pem'), path.join(root, 'outside.pem'));
    for (const p of ['../outside.pem', path.join(root, 'outside.pem')]) {
      let msg = '';
      try {
        loadCaBundleFile(cfg, p);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/inside the Gateway config directory/);
      expect(msg).not.toContain(root);
    }
  });

  it('refuses a link inside the config directory that points outside it', () => {
    copyFileSync(path.join(TLS_DIR, 'test-ca.pem'), path.join(root, 'outside.pem'));
    try {
      symlinkSync(path.join(root, 'outside.pem'), path.join(configDir, 'link.pem'));
    } catch {
      return; // creating symlinks needs Developer Mode/admin on Windows; covered on other platforms
    }
    expect(() => loadCaBundleFile(cfg, 'link.pem')).toThrow(/inside the Gateway config directory/);
  });

  it('refuses a missing file, a directory, the config dir itself, and invalid content', () => {
    expect(() => loadCaBundleFile(cfg, 'missing.pem')).toThrow(/does not exist/);
    mkdirSync(path.join(configDir, 'dir.pem'));
    expect(() => loadCaBundleFile(cfg, 'dir.pem')).toThrow(/must name a file/);
    expect(() => loadCaBundleFile(cfg, '.')).toThrow(/inside the Gateway config directory/);
    writeFileSync(path.join(configDir, 'leaf.pem'), readFileSync(path.join(TLS_DIR, 'localhost.pem')));
    expect(() => loadCaBundleFile(cfg, 'leaf.pem')).toThrow(/not a CA certificate/);
  });

  it('resolveAgentConfig reads the CA bundle once, at start-up', () => {
    writeFileSync(cfg, JSON.stringify({ tls: { extraCaCertsFile: 'corp-ca.pem', useWindowsCertificateStore: true } }));
    const resolved = resolveAgentConfig({ GATEWAY_CONFIG_PATH: cfg, GATEWAY_STATE_DIR: path.join(root, 'state') }, 'win32');
    expect(resolved.tlsTrust.extraCaCertificates).toHaveLength(1);
    expect(resolved.tlsTrust.useWindowsCertificateStore).toBe(true);
  });

  it('resolveAgentConfig fails start-up on an invalid CA file rather than silently trusting less', () => {
    writeFileSync(cfg, JSON.stringify({ tls: { extraCaCertsFile: 'missing.pem' } }));
    expect(() => resolveAgentConfig({ GATEWAY_CONFIG_PATH: cfg, GATEWAY_STATE_DIR: path.join(root, 'state') }, 'win32')).toThrow(AgentConfigError);
  });
});
