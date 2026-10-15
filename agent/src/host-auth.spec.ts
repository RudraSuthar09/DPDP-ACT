import { evaluateHost, hostnameFromHostHeader } from './host-auth';

const LOOPBACK_CFG = { bindHost: '127.0.0.1', allowedHosts: [] as string[] };

describe('hostnameFromHostHeader', () => {
  it.each([
    ['localhost:7071', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['127.0.0.1:7071', '127.0.0.1'],
    ['[::1]:7071', '::1'],
    ['[::1]', '::1'],
    ['gateway.corp.local:7071', 'gateway.corp.local'],
  ])('%s -> %s', (header, expected) => {
    expect(hostnameFromHostHeader(header)).toBe(expected);
  });

  it.each([
    [undefined],
    [''],
    ['::1'], // unbracketed IPv6 is not a valid Host
    ['localhost:abc'],
    ['evil.com/path'],
    ['user@localhost'],
    ['local host'],
    ['[::1'],
    ['[::1]x'],
    ['[localhost]'],
  ])('rejects malformed %p', (header) => {
    expect(hostnameFromHostHeader(header as string | undefined)).toBeNull();
  });

  it('rejects a duplicated (array) Host header', () => {
    expect(hostnameFromHostHeader(['localhost', 'evil.com'])).toBeNull();
  });
});

describe('evaluateHost — DNS-rebinding defense', () => {
  it('allows loopback names and loopback IP literals', () => {
    for (const h of ['localhost:7071', '127.0.0.1:7071', '127.5.5.5', '[::1]:7071']) {
      expect(evaluateHost(h, LOOPBACK_CFG)).toEqual({ allowed: true, loopback: true });
    }
  });

  it('denies an attacker hostname that merely RESOLVES to 127.0.0.1 (the rebinding case)', () => {
    expect(evaluateHost('rebind.attacker.example:7071', LOOPBACK_CFG)).toEqual({ allowed: false, loopback: false });
    expect(evaluateHost('localhost.attacker.example', LOOPBACK_CFG).allowed).toBe(false);
    expect(evaluateHost('127.0.0.1.nip.io', LOOPBACK_CFG).allowed).toBe(false);
  });

  it('denies a missing Host header', () => {
    expect(evaluateHost(undefined, LOOPBACK_CFG).allowed).toBe(false);
  });

  it('allows the configured non-loopback bind host, but marks it non-loopback', () => {
    expect(evaluateHost('192.168.1.50:7071', { bindHost: '192.168.1.50', allowedHosts: [] })).toEqual({ allowed: true, loopback: false });
  });

  it('allows an admin-allowlisted DNS name (GATEWAY_ALLOWED_HOSTS), non-loopback', () => {
    expect(evaluateHost('gateway.corp.local:7071', { bindHost: '0.0.0.0', allowedHosts: ['gateway.corp.local'] })).toEqual({
      allowed: true,
      loopback: false,
    });
  });
});
