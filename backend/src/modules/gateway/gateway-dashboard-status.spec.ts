import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Probe = { reached: boolean; body?: Record<string, unknown> | null } | null;
type Device = { status: string; endpoint: string | null; lastHeartbeatAt?: string | null } | null;
// Loaded at RUNTIME (ts-jest compiles it), not imported statically: the
// frontend lives outside the backend's tsconfig rootDir, and a static import
// would make the backend's own typecheck/build pull it in.
const { classifyBrowserAccess, classifyGatewayConnection, HEARTBEAT_ONLINE_WINDOW_MS, isHeartbeatRecent } = jest.requireActual(
  join(__dirname, '..', '..', '..', '..', 'frontend', 'src', 'lib', 'gateway-connection.ts'),
) as {
  classifyBrowserAccess: (device: { endpoint: string | null } | null, probe: Probe) => string;
  classifyGatewayConnection: (device: Device, probe: Probe, now?: number) => string;
  HEARTBEAT_ONLINE_WINDOW_MS: number;
  isHeartbeatRecent: (at: string | null | undefined, now?: number) => boolean;
};

/**
 * Phase 6 regression (frontend logic, run here because the frontend has no
 * unit-test runner; the Phase 3G-2.5 guard already reads frontend files the
 * same way). The defect: the Data Sources panel decided "connected" ONLY by a
 * browser probe of a manually entered endpoint, so a paired, heart-beating
 * Gateway showed "Endpoint not configured"/"Offline".
 */
const NOW = Date.parse('2026-10-20T10:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('Gateway status on the dashboard comes from the heartbeat', () => {
  it('a recent heartbeat is Online even with NO endpoint (the reported defect)', () => {
    expect(classifyGatewayConnection({ status: 'active', endpoint: null, lastHeartbeatAt: ago(30_000) }, null, NOW)).toBe('connected');
  });

  it('a recent heartbeat is Online even if THIS browser cannot reach the Gateway', () => {
    expect(classifyGatewayConnection({ status: 'active', endpoint: 'http://gw.example:7071', lastHeartbeatAt: ago(30_000) }, { reached: false }, NOW)).toBe(
      'connected',
    );
  });

  it('a stale or missing heartbeat is Offline', () => {
    expect(classifyGatewayConnection({ status: 'active', endpoint: null, lastHeartbeatAt: ago(HEARTBEAT_ONLINE_WINDOW_MS + 1000) }, null, NOW)).toBe(
      'offline',
    );
    expect(classifyGatewayConnection({ status: 'active', endpoint: null, lastHeartbeatAt: null }, null, NOW)).toBe('offline');
  });

  it('no active device is Not connected', () => {
    expect(classifyGatewayConnection(null, null, NOW)).toBe('not_configured');
    expect(classifyGatewayConnection({ status: 'revoked', endpoint: null, lastHeartbeatAt: ago(1000) }, null, NOW)).toBe('not_configured');
  });

  it('isHeartbeatRecent rejects garbage and far-future timestamps', () => {
    expect(isHeartbeatRecent('not a date', NOW)).toBe(false);
    expect(isHeartbeatRecent(new Date(NOW + 24 * 3600_000).toISOString(), NOW)).toBe(false);
  });
});

describe('browser access (needed only for browsing through the Gateway) is reported separately', () => {
  it('classifies the probe of the self-registered endpoint', () => {
    expect(classifyBrowserAccess({ endpoint: null }, null)).toBe('no_endpoint');
    expect(classifyBrowserAccess({ endpoint: 'http://gw.example:7071' }, { reached: false })).toBe('unreachable');
    expect(classifyBrowserAccess({ endpoint: 'http://gw.example:7071' }, { reached: true, body: { status: 'ok', agentVersion: '0.1.0' } })).toBe('reachable');
    expect(classifyBrowserAccess({ endpoint: 'http://gw.example:7071' }, { reached: true, body: { hello: 1 } })).toBe('invalid');
  });
});

describe('the normal customer workflow needs no hand-entered address or token', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', 'frontend', 'src');
  const code = (f: string): string => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('the Gateway admin panel keeps the address field only under "Advanced"', () => {
    const page = code('components/SourceAdministration.tsx');
    const advanced = page.indexOf('<details');
    expect(advanced).toBeGreaterThan(-1);
    expect(page.indexOf('id="gw-endpoint"')).toBeGreaterThan(advanced);
  });

  it('the Gateway browser connects through the shared pairing handshake; manual fields only under "Advanced"', () => {
    const page = code('app/(app)/data-sources/[id]/gateway/page.tsx');
    expect(page).toContain('openGatewaySession(sourceId)');
    const advanced = page.indexOf('<details');
    expect(advanced).toBeGreaterThan(-1);
    expect(page.indexOf('id="gw-token"')).toBeGreaterThan(advanced);
  });

  it('customer resolution reuses the same handshake (no second copy of pairing/establish)', () => {
    const lib = code('lib/customer-resolution.ts');
    expect(lib).toContain('openGatewaySession(');
    expect(lib).not.toContain("'/gateway/pairings'");
    expect(lib).not.toContain('/session/establish');
  });
});
