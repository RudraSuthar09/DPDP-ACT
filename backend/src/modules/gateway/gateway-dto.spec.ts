import { parseCreatePairing, parseEnrollDevice, parseRedeemPairing } from './gateway.dto';

const A_PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\n' + 'A'.repeat(120) + '\n-----END PUBLIC KEY-----';

describe('Phase 3C — enrolment DTO refuses private keys / credentials (I1 + private key stays local)', () => {
  const base = { publicKey: A_PUBLIC_KEY, platform: 'windows', agentVersion: '0.1.0', displayName: 'Finance server' };

  it('accepts a well-formed public-key enrolment', () => {
    const out = parseEnrollDevice(base);
    expect(out.platform).toBe('windows');
    expect(out.publicKey).toContain('PUBLIC KEY');
  });

  it('11. rejects a body carrying a private key', () => {
    expect(() => parseEnrollDevice({ ...base, privateKey: 'x' })).toThrow(/never accepts/i);
    expect(() => parseEnrollDevice({ ...base, private_key: 'x' })).toThrow();
  });

  it('11. rejects a body carrying any credential/secret field', () => {
    for (const field of ['secret', 'password', 'credential', 'connectionString', 'dsn', 'token']) {
      expect(() => parseEnrollDevice({ ...base, [field]: 'x' })).toThrow();
    }
  });

  it('rejects a "publicKey" that is actually a private key', () => {
    expect(() =>
      parseEnrollDevice({ ...base, publicKey: '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(120) + '\n-----END PRIVATE KEY-----' }),
    ).toThrow(/public key/i);
  });

  it('rejects an unknown platform', () => {
    expect(() => parseEnrollDevice({ ...base, platform: 'solaris' })).toThrow();
  });

  it('pairing/redeem DTOs also refuse secret fields and require ids', () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    expect(parseCreatePairing({ sourceId: uuid, deviceId: uuid })).toEqual({ sourceId: uuid, deviceId: uuid });
    expect(() => parseCreatePairing({ sourceId: uuid, deviceId: uuid, password: 'x' })).toThrow();
    expect(() => parseCreatePairing({ sourceId: 'not-a-uuid', deviceId: uuid })).toThrow();
    expect(parseRedeemPairing({ nonce: 'n'.repeat(20), sourceId: uuid })).toMatchObject({ sourceId: uuid });
  });
});
