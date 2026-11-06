import { BadRequestException } from '@nestjs/common';
import { GATEWAY_LOOPBACK_HOST } from '@dpdp/shared';
import { parseHeartbeat } from './gateway.dto';
import { GatewayService, isLoopbackEndpoint } from './gateway.service';

/**
 * Phase 6: the dashboard showed an enrolled, heart-beating Gateway as needing
 * a manually typed endpoint, because nothing ever told the platform the
 * Gateway's local address, and nothing told the Gateway which dashboard
 * origins may call it. The EXISTING heartbeat now carries both:
 *   agent -> backend: its loopback listener (`localEndpoint`, optional);
 *   backend -> agent: the dashboard origins (`dashboardOrigins`).
 * Built from the shared constant, never a literal (see the endpoint guard).
 */
const LOOPBACK = `http://${GATEWAY_LOOPBACK_HOST}`;

describe('parseHeartbeat — localEndpoint is optional and loopback-only', () => {
  it('stays backward compatible: no localEndpoint is fine', () => {
    expect(parseHeartbeat({ agentVersion: '0.1.0' })).toEqual({ agentVersion: '0.1.0', localEndpoint: null });
    expect(parseHeartbeat({ agentVersion: '0.1.0', localEndpoint: null })).toEqual({ agentVersion: '0.1.0', localEndpoint: null });
  });

  it('accepts http on the loopback host with a port, normalised to the origin', () => {
    expect(parseHeartbeat({ agentVersion: '0.1.0', localEndpoint: `${LOOPBACK}:7072` })).toEqual({
      agentVersion: '0.1.0',
      localEndpoint: `${LOOPBACK}:7072`,
    });
    expect(parseHeartbeat({ agentVersion: '0.1.0', localEndpoint: `${LOOPBACK}:7072/` }).localEndpoint).toBe(`${LOOPBACK}:7072`);
  });

  it.each([
    ['a network address', 'http://192.0.2.10:7071'],
    ['a DNS name', 'http://gateway.example:7071'],
    ['https', `https://${GATEWAY_LOOPBACK_HOST}:7071`],
    ['no port', LOOPBACK],
    ['a path', `${LOOPBACK}:7071/x`],
    ['a query', `${LOOPBACK}:7071/?a=1`],
    ['user info', `http://u:p@${GATEWAY_LOOPBACK_HOST}:7071`],
    ['not a URL', 'not a url'],
    ['not a string', 7071],
  ])('rejects %s', (_label, localEndpoint) => {
    expect(() => parseHeartbeat({ agentVersion: '0.1.0', localEndpoint })).toThrow(BadRequestException);
  });

  it('still rejects secret-shaped fields on the heartbeat', () => {
    expect(() => parseHeartbeat({ agentVersion: '0.1.0', token: 'x' })).toThrow(BadRequestException);
  });
});

describe('GatewayService.heartbeat — endpoint self-registration and dashboard origins', () => {
  function makeService(endpoint: string | null, webOrigin = 'https://app.dpdp.example') {
    process.env.WEB_ORIGIN = webOrigin;
    const repo = {
      findDevice: jest.fn().mockResolvedValue({ id: 'd1', status: 'active', endpoint, installation_id: null }),
      touchHeartbeat: jest.fn().mockResolvedValue({}),
      setEndpoint: jest.fn().mockResolvedValue({}),
    };
    const audit = { annotate: jest.fn() };
    const config = { get: () => undefined };
    const service = new GatewayService(
      repo as never,
      {} as never,
      audit as never,
      {} as never,
      {} as never,
      { touchHeartbeat: jest.fn() } as never,
      {} as never,
      config as never,
    );
    return { service, repo, audit };
  }
  afterEach(() => {
    delete process.env.WEB_ORIGIN;
  });

  it('fills an EMPTY endpoint from the self-reported loopback address', async () => {
    const { service, repo } = makeService(null);
    await service.heartbeat('d1', '0.1.0', `${LOOPBACK}:7071`);
    expect(repo.setEndpoint).toHaveBeenCalledWith('d1', `${LOOPBACK}:7071`);
  });

  it('refreshes an endpoint that is itself loopback (e.g. the port changed)', async () => {
    const { service, repo } = makeService(`${LOOPBACK}:7071`);
    await service.heartbeat('d1', '0.1.0', `${LOOPBACK}:7072`);
    expect(repo.setEndpoint).toHaveBeenCalledWith('d1', `${LOOPBACK}:7072`);
  });

  it('NEVER overwrites a staff-configured network endpoint', async () => {
    const { service, repo } = makeService('https://gateway.corp.example:7071');
    await service.heartbeat('d1', '0.1.0', `${LOOPBACK}:7071`);
    expect(repo.setEndpoint).not.toHaveBeenCalled();
  });

  it('writes nothing when the endpoint is unchanged or not reported (old agents)', async () => {
    const same = makeService(`${LOOPBACK}:7071`);
    await same.service.heartbeat('d1', '0.1.0', `${LOOPBACK}:7071`);
    expect(same.repo.setEndpoint).not.toHaveBeenCalled();
    const old = makeService(null);
    await old.service.heartbeat('d1', '0.1.0');
    expect(old.repo.setEndpoint).not.toHaveBeenCalled();
  });

  it('returns the dashboard origins the API itself allows (WEB_ORIGIN), for the Gateway listener', async () => {
    const { service } = makeService(null, 'https://app.dpdp.example, https://admin.dpdp.example');
    const res = await service.heartbeat('d1', '0.1.0');
    expect(res).toEqual({ deviceStatus: 'active', boundSourceIds: [], dashboardOrigins: ['https://app.dpdp.example', 'https://admin.dpdp.example'] });
  });

  it('a revoked device gets no endpoint change and no origins (heartbeat refused)', async () => {
    const { service, repo } = makeService(null);
    repo.findDevice.mockResolvedValue({ id: 'd1', status: 'revoked', endpoint: null, installation_id: null });
    await expect(service.heartbeat('d1', '0.1.0', `${LOOPBACK}:7071`)).rejects.toThrow();
    expect(repo.setEndpoint).not.toHaveBeenCalled();
  });
});

describe('isLoopbackEndpoint', () => {
  it('recognises only the loopback host', () => {
    expect(isLoopbackEndpoint(`${LOOPBACK}:7071`)).toBe(true);
    expect(isLoopbackEndpoint('https://gateway.corp.example')).toBe(false);
    expect(isLoopbackEndpoint('garbage')).toBe(false);
  });
});
