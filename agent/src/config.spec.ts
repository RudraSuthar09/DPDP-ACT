import { GATEWAY_LOOPBACK_HOST } from '@dpdp/shared';
import {
  loadAgentConfig,
  AgentConfigError,
  isLoopbackHost,
  isValidBindHost,
  isExactOrigin,
  resolvePlatform,
  DEFAULT_BIND_PORT,
} from './config';

describe('Phase 3B — agent network configuration is env-driven with secure defaults', () => {
  it('1. default bind host is secure/local (loopback), never 0.0.0.0', () => {
    const c = loadAgentConfig({});
    expect(c.bindHost).toBe('127.0.0.1');
    expect(c.bindHost).not.toBe('0.0.0.0');
    expect(c.networkMode).toBe('loopback');
    // the secure default comes from the Phase-3A contract constant
    expect(GATEWAY_LOOPBACK_HOST).toBe('127.0.0.1');
  });

  it('2. a custom bind host can be supplied through configuration', () => {
    expect(loadAgentConfig({ GATEWAY_BIND_HOST: '127.0.0.5' }).bindHost).toBe('127.0.0.5');
  });

  it('3. a custom LAN address is accepted and reported as non-loopback', () => {
    const c = loadAgentConfig({ GATEWAY_BIND_HOST: '192.168.1.50' });
    expect(c.bindHost).toBe('192.168.1.50');
    expect(c.networkMode).toBe('non-loopback');
  });

  it('3b. 0.0.0.0 is never the default, but is allowed (non-loopback) only when explicit', () => {
    expect(loadAgentConfig({}).bindHost).not.toBe('0.0.0.0');
    const c = loadAgentConfig({ GATEWAY_BIND_HOST: '0.0.0.0' });
    expect(c.bindHost).toBe('0.0.0.0');
    expect(c.networkMode).toBe('non-loopback');
  });

  it('4. an invalid bind address is rejected', () => {
    for (const bad of ['not a host!', '1.2.3.4.5', '', '999.1.1.1', 'has space', '*']) {
      expect(() => loadAgentConfig({ GATEWAY_BIND_HOST: bad })).toThrow(AgentConfigError);
    }
  });

  it('5. the port is configurable, and an invalid port is rejected', () => {
    expect(loadAgentConfig({}).bindPort).toBe(DEFAULT_BIND_PORT);
    expect(loadAgentConfig({ GATEWAY_BIND_PORT: '9000' }).bindPort).toBe(9000);
    for (const bad of ['0', '70000', 'abc', '-1', '3.5']) {
      expect(() => loadAgentConfig({ GATEWAY_BIND_PORT: bad })).toThrow(AgentConfigError);
    }
  });

  it('6. allowed origins come from configuration (default empty, exact list parsed)', () => {
    expect(loadAgentConfig({}).allowedOrigins).toEqual([]);
    expect(
      loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: 'https://a.example, https://b.example:8443' })
        .allowedOrigins,
    ).toEqual(['https://a.example', 'https://b.example:8443']);
  });

  it('9. a wildcard "*" origin is rejected at config load', () => {
    expect(() => loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: '*' })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: 'https://*.example' })).toThrow(
      AgentConfigError,
    );
  });

  it('an origin with a path or bad scheme is rejected (exact origin only)', () => {
    expect(() => loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: 'https://a.example/app' })).toThrow(
      AgentConfigError,
    );
    expect(() => loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: 'notaurl' })).toThrow(AgentConfigError);
  });

  it('11. the control-plane URL is configuration-driven and validated (not used in 3B)', () => {
    expect(loadAgentConfig({}).controlPlaneUrl).toBeNull();
    expect(loadAgentConfig({ GATEWAY_CONTROL_PLANE_URL: 'https://control.example' }).controlPlaneUrl).toBe(
      'https://control.example',
    );
    for (const bad of ['ftp://x', 'not a url']) {
      expect(() => loadAgentConfig({ GATEWAY_CONTROL_PLANE_URL: bad })).toThrow(AgentConfigError);
    }
  });

  it('the three network concepts are independent (bind vs origins vs control plane)', () => {
    const c = loadAgentConfig({
      GATEWAY_BIND_HOST: '192.168.1.50',
      GATEWAY_BIND_PORT: '8080',
      GATEWAY_ALLOWED_ORIGINS: 'https://app.example',
      GATEWAY_CONTROL_PLANE_URL: 'https://control.example',
    });
    expect(c.bindHost).toBe('192.168.1.50');
    expect(c.bindPort).toBe(8080);
    expect(c.allowedOrigins).toEqual(['https://app.example']);
    expect(c.controlPlaneUrl).toBe('https://control.example');
  });

  it('helpers: loopback detection + host/origin validators behave', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.50')).toBe(false);

    expect(isValidBindHost('10.0.0.1')).toBe(true);
    expect(isValidBindHost('agent.internal.example')).toBe(true);
    expect(isValidBindHost('*')).toBe(false);

    expect(isExactOrigin('https://a.example')).toBe(true);
    expect(isExactOrigin('https://a.example:8443')).toBe(true);
    expect(isExactOrigin('https://a.example/app')).toBe(false);
    expect(isExactOrigin('*')).toBe(false);
  });

  it('Phase 3C: enrollment config has sensible defaults and validates', () => {
    const c = loadAgentConfig({}, 'linux');
    expect(c.enrollmentCode).toBeNull();
    expect(c.heartbeatIntervalSeconds).toBe(60);
    expect(c.stateDir.length).toBeGreaterThan(0);
    expect(c.displayName.length).toBeGreaterThan(0);
    expect(c.platform).toBe('linux');

    const c2 = loadAgentConfig(
      {
        GATEWAY_STATE_DIR: '/tmp/my-gateway-state',
        GATEWAY_ENROLLMENT_CODE: '  a-code  ',
        GATEWAY_DISPLAY_NAME: 'Finance workstation',
        GATEWAY_HEARTBEAT_INTERVAL_SECONDS: '30',
      },
      'win32',
    );
    expect(c2.stateDir).toBe('/tmp/my-gateway-state');
    expect(c2.enrollmentCode).toBe('a-code');
    expect(c2.displayName).toBe('Finance workstation');
    expect(c2.heartbeatIntervalSeconds).toBe(30);
    expect(c2.platform).toBe('windows');
  });

  it('Phase 3C: an invalid heartbeat interval is rejected', () => {
    for (const bad of ['0', '4', '-1', 'abc', '3.5']) {
      expect(() => loadAgentConfig({ GATEWAY_HEARTBEAT_INTERVAL_SECONDS: bad }, 'linux')).toThrow(
        AgentConfigError,
      );
    }
  });

  it('Phase 3C: platform is derived from the runtime, never guessed — win32/linux map, everything else fails closed', () => {
    expect(resolvePlatform('win32')).toBe('windows');
    expect(resolvePlatform('linux')).toBe('linux');
    for (const unsupported of ['darwin', 'freebsd', 'sunos'] as const) {
      expect(() => resolvePlatform(unsupported)).toThrow(AgentConfigError);
    }
  });
});
