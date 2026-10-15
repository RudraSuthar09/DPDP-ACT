import { AgentConfigError } from './config';
import { matchesNoProxy, parseNoProxy, parseProxyUrl, resolveProxySettings, selectProxy } from './network-config';

const SECRET = 'S3cr3t-Pr0xy-PW';

describe('parseProxyUrl', () => {
  const opts = { label: 'TEST', allowCredentials: true };

  it('accepts http/https proxies, fills default ports, strips user info from the URI', () => {
    expect(parseProxyUrl('http://proxy.corp:3128', opts)).toEqual({ uri: 'http://proxy.corp:3128', protocol: 'http:', credentials: null });
    expect(parseProxyUrl('https://proxy.corp', opts).uri).toBe('https://proxy.corp:443');
    expect(parseProxyUrl('http://proxy.corp/', opts).uri).toBe('http://proxy.corp:80');
    const withCreds = parseProxyUrl(`http://svc%40corp:${encodeURIComponent(SECRET)}@proxy.corp:8080`, opts);
    expect(withCreds.uri).toBe('http://proxy.corp:8080');
    expect(withCreds.credentials).toEqual({ username: 'svc@corp', password: SECRET });
  });

  it('treats a scheme-less host:port as http:// (curl rule)', () => {
    expect(parseProxyUrl('proxy.corp:8080', opts).uri).toBe('http://proxy.corp:8080');
  });

  it('accepts an IPv6 proxy', () => {
    expect(parseProxyUrl('http://[fd00::1]:8080', opts).uri).toBe('http://[fd00::1]:8080');
  });

  it.each([
    ['socks5://proxy.corp:1080', /SOCKS/],
    ['ftp://proxy.corp', /http:\/\/ or https:\/\//],
    ['http://proxy.corp:8080/path', /no path/],
    ['http://proxy.corp:8080/?q=1', /no path/],
    ['http://', /not a valid proxy URL|no host/],
    ['   ', /empty/],
    ['http://proxy.corp:99999', /not a valid proxy URL/],
  ])('rejects %s', (raw, msg) => {
    expect(() => parseProxyUrl(raw, opts)).toThrow(msg);
  });

  it('rejects user info where credentials are not allowed (config.json), without echoing it', () => {
    let err: unknown;
    try {
      parseProxyUrl(`http://user:${SECRET}@proxy.corp:8080`, { label: '"proxy.url"', allowCredentials: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentConfigError);
    expect((err as Error).message).toMatch(/proxy-credentials\.json/);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).not.toContain('proxy.corp');
  });

  it('never echoes the URL in any validation error', () => {
    for (const raw of [`socks5://u:${SECRET}@h.corp:1`, `http://u:${SECRET}@h.corp:1/x`]) {
      try {
        parseProxyUrl(raw, opts);
      } catch (e) {
        expect((e as Error).message).not.toContain(SECRET);
        expect((e as Error).message).not.toContain('h.corp');
      }
    }
  });

  it('rejects a user name containing ":" (Basic auth cannot carry it)', () => {
    expect(() => parseProxyUrl('http://a%3Ab:pw@proxy.corp', opts)).toThrow(/must not contain ':'/);
  });
});

describe('NO_PROXY matching', () => {
  const rules = parseNoProxy('internal.corp, .svc.example  *.wild.example,10.0.0.0/8,192.168.1.5,[fd00::1]:8443,api.only:8443,<local>', 'NO_PROXY');
  const m = (url: string): boolean => matchesNoProxy(new URL(url), rules);

  it('a domain matches itself and its subdomains, not look-alikes', () => {
    expect(m('https://internal.corp')).toBe(true);
    expect(m('https://a.b.internal.corp')).toBe(true);
    expect(m('https://notinternal.corp')).toBe(false);
    expect(m('https://internal.corp.evil.example')).toBe(false);
  });

  it('leading "." and "*." forms are equivalent to the bare domain', () => {
    expect(m('https://svc.example')).toBe(true);
    expect(m('https://x.svc.example')).toBe(true);
    expect(m('https://wild.example')).toBe(true);
    expect(m('https://deep.x.wild.example')).toBe(true);
  });

  it('is case-insensitive and ignores a trailing dot', () => {
    expect(m('https://API.INTERNAL.CORP')).toBe(true);
    expect(m('https://internal.corp.')).toBe(true);
  });

  it('CIDR and exact IP entries match literal addresses only', () => {
    expect(m('http://10.20.30.40')).toBe(true);
    expect(m('http://11.0.0.1')).toBe(false);
    expect(m('http://192.168.1.5:9000')).toBe(true);
    expect(m('http://192.168.1.6')).toBe(false);
  });

  it('a port-qualified entry matches only that port', () => {
    expect(m('https://[fd00::1]:8443')).toBe(true);
    expect(m('https://[fd00::1]')).toBe(false);
    expect(m('https://api.only:8443')).toBe(true);
    expect(m('https://api.only')).toBe(false);
  });

  it('"<local>" matches dot-less host names only', () => {
    expect(m('https://intranet')).toBe(true);
    expect(m('https://intranet.example')).toBe(false);
  });

  it('"*" alone bypasses everything', () => {
    expect(matchesNoProxy(new URL('https://anything.example'), parseNoProxy('*', 'NO_PROXY'))).toBe(true);
  });

  it.each(['10.0.0.0/33', 'bad host!', 'host:0', 'host:abc'])('rejects invalid entry %s', (entry) => {
    expect(() => parseNoProxy(entry, 'NO_PROXY')).toThrow(AgentConfigError);
  });
});

describe('resolveProxySettings precedence', () => {
  const ENV = { HTTPS_PROXY: 'http://env-proxy.corp:8080', HTTP_PROXY: 'http://env-http.corp:8080', NO_PROXY: 'skip.example' };

  it('config.json "proxy" wins over environment variables (and says so)', () => {
    const s = resolveProxySettings({ url: 'http://file-proxy.corp:3128', noProxy: ['file-skip.example'] }, ENV);
    expect(s.source).toBe('config');
    expect(s.httpsProxy?.uri).toBe('http://file-proxy.corp:3128');
    expect(s.httpProxy?.uri).toBe('http://file-proxy.corp:3128');
    expect(selectProxy(s, 'https://skip.example')).not.toBeNull(); // env NO_PROXY ignored
    expect(selectProxy(s, 'https://file-skip.example')).toBeNull();
    expect(s.warnings.join(' ')).toMatch(/environment variable\(s\) are ignored/);
  });

  it('config.json "proxy": "none" forces direct even when environment proxies exist', () => {
    const s = resolveProxySettings('none', ENV);
    expect(s.source).toBe('none');
    expect(selectProxy(s, 'https://dpdp.example')).toBeNull();
    expect(s.warnings.join(' ')).toMatch(/ignored/);
  });

  it('environment is used when config.json has no proxy; lower-case wins', () => {
    const s = resolveProxySettings(undefined, { ...ENV, https_proxy: 'http://lower.corp:1' });
    expect(s.source).toBe('environment');
    expect(s.httpsProxy?.uri).toBe('http://lower.corp:1');
    expect(selectProxy(s, 'https://skip.example')).toBeNull();
    expect(selectProxy(s, 'http://plain.example')?.uri).toBe('http://env-http.corp:8080');
  });

  it('environment proxies may carry user info', () => {
    const s = resolveProxySettings(undefined, { HTTPS_PROXY: `http://u:${SECRET}@p.corp:1` });
    expect(s.httpsProxy?.credentials).toEqual({ username: 'u', password: SECRET });
    expect(s.httpsProxy?.uri).not.toContain(SECRET);
  });

  it('HTTP_PROXY alone does not proxy https:// (curl/Node convention) and warns', () => {
    const s = resolveProxySettings(undefined, { HTTP_PROXY: 'http://p.corp:1' });
    expect(selectProxy(s, 'https://dpdp.example')).toBeNull();
    expect(s.warnings.join(' ')).toMatch(/HTTPS_PROXY is not/);
  });

  it('no configuration at all means direct', () => {
    const s = resolveProxySettings(undefined, {});
    expect(s).toMatchObject({ source: 'none', httpProxy: null, httpsProxy: null });
    expect(s.warnings).toEqual([]);
  });

  it('proxy-credentials.json applies only to the config.json proxy', () => {
    const creds = { username: 'svc', password: SECRET };
    expect(resolveProxySettings({ url: 'http://p.corp:1' }, {}, creds).httpsProxy?.credentials).toEqual(creds);
    const envOnly = resolveProxySettings(undefined, { HTTPS_PROXY: 'http://p.corp:1' }, creds);
    expect(envOnly.httpsProxy?.credentials).toBeNull();
    expect(envOnly.warnings.join(' ')).toMatch(/proxy-credentials\.json is present/);
  });

  it('an invalid environment proxy is a configuration error, never silently ignored', () => {
    expect(() => resolveProxySettings(undefined, { HTTPS_PROXY: 'socks5://p.corp:1080' })).toThrow(/HTTPS_PROXY must use http/);
  });

  it('loopback destinations are always direct, even with a catch-all proxy', () => {
    const s = resolveProxySettings({ url: 'http://p.corp:1' }, {});
    for (const url of ['http://localhost:3001', 'https://127.0.0.1', 'http://127.8.9.10:1', 'http://[::1]:7071', 'http://app.localhost']) {
      expect(selectProxy(s, url)).toBeNull();
    }
    expect(selectProxy(s, 'https://dpdp.example')?.uri).toBe('http://p.corp:1');
  });
});
