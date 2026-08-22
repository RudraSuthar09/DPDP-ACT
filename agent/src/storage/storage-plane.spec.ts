import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageSessionStore } from './storage-session-store';
import { StorageRegistry } from './registry';
import { StoragePlane, handleStoragePlaneRequest, type StorageControlPlaneClient } from './storage-plane';

const NOW = Date.now();
const FUTURE = new Date(NOW + 60_000).toISOString();

describe('storage plane — StorageSessionStore binding', () => {
  const store = new StorageSessionStore();
  store.put({ token: 'good', tenantId: 'A', storageRootId: 'root1', deviceId: 'D', expiresAt: NOW + 60_000 });

  it('validates a good session bound to the right tenant + storage root', () => {
    expect(store.validate('good', { tenantId: 'A', storageRootId: 'root1', now: NOW }).storageRootId).toBe('root1');
  });
  it('invalid token fails', () => {
    expect(() => store.validate('nope', { tenantId: 'A', storageRootId: 'root1', now: NOW })).toThrow(/INVALID_TOKEN/);
  });
  it('expired session fails', () => {
    store.put({ token: 'old', tenantId: 'A', storageRootId: 'root1', deviceId: 'D', expiresAt: NOW - 1 });
    expect(() => store.validate('old', { tenantId: 'A', storageRootId: 'root1', now: NOW })).toThrow(/SESSION_EXPIRED/);
  });
  it('tenant mismatch fails', () => {
    expect(() => store.validate('good', { tenantId: 'B', storageRootId: 'root1', now: NOW })).toThrow(/TENANT_MISMATCH/);
  });
  it('storage root mismatch fails', () => {
    expect(() => store.validate('good', { tenantId: 'A', storageRootId: 'root2', now: NOW })).toThrow(/STORAGE_ROOT_MISMATCH/);
  });
});

describe('storage plane — StoragePlane request handling', () => {
  let root: string;
  let sp: StoragePlane;

  const fakeControl: StorageControlPlaneClient = {
    async redeemStoragePairing() {
      return { sessionToken: 'SESSION-TOKEN', expiresAt: FUTURE };
    },
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-sp-'));
    const registry = new StorageRegistry([{ storageRootId: 'root1', rootPath: root }]);
    sp = new StoragePlane(registry, new StorageSessionStore(), { tenantId: 'A', deviceId: 'D' }, fakeControl);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function establish() {
    const r = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/session/establish',
      sessionToken: undefined,
      body: { storageRootId: 'root1', nonce: 'a-valid-nonce-value' },
    });
    expect(r.status).toBe(200);
    return (r.json as { sessionToken: string }).sessionToken;
  }

  it('establish -> createFolder -> browse -> verifyFolder (real fs, round trip)', async () => {
    const token = await establish();

    const created = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/folder/create',
      sessionToken: token,
      body: { storageRootId: 'root1', path: [], name: 'Customers' },
    });
    expect(created.status).toBe(200);
    expect(created.json).toEqual({ created: true });

    const browsed = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/browse',
      sessionToken: token,
      body: { storageRootId: 'root1', path: [] },
    });
    expect(browsed.status).toBe(200);
    expect(browsed.json).toEqual({ entries: [{ name: 'Customers' }] });

    const verified = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/folder/verify',
      sessionToken: token,
      body: { storageRootId: 'root1', path: ['Customers'] },
    });
    expect(verified.status).toBe(200);
    expect(verified.json).toEqual({ exists: true });

    const missing = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/folder/verify',
      sessionToken: token,
      body: { storageRootId: 'root1', path: ['NoSuchFolder'] },
    });
    expect(missing.json).toEqual({ exists: false });
  });

  it('every op except establish requires a session token', async () => {
    const r = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/browse',
      sessionToken: undefined,
      body: { storageRootId: 'root1', path: [] },
    });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'INVALID_TOKEN' });
  });

  it('an unconfigured storage root fails closed on establish', async () => {
    const r = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/session/establish',
      sessionToken: undefined,
      body: { storageRootId: 'root-does-not-exist', nonce: 'a-valid-nonce-value' },
    });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'STORAGE_ROOT_NOT_AUTHORIZED' });
  });

  it('a session established for one root cannot browse another root', async () => {
    const token = await establish();
    const r = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/browse',
      sessionToken: token,
      body: { storageRootId: 'root-other', path: [] },
    });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'STORAGE_ROOT_MISMATCH' });
  });

  it('a path traversal attempt is rejected with a coded, sanitized error (no path echoed)', async () => {
    const token = await establish();
    const r = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/browse',
      sessionToken: token,
      body: { storageRootId: 'root1', path: ['..'] },
    });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'PATH_NOT_ALLOWED' });
  });

  it('a malformed path (non-array) is rejected at the HTTP edge', async () => {
    const token = await establish();
    const r = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/browse',
      sessionToken: token,
      body: { storageRootId: 'root1', path: 'not-an-array' },
    });
    expect(r.status).toBe(400);
  });

  it('an unknown storage-plane path 404s', async () => {
    const token = await establish();
    const r = await handleStoragePlaneRequest(sp, {
      method: 'POST',
      path: '/storage/unknown',
      sessionToken: token,
      body: { storageRootId: 'root1' },
    });
    expect(r.json).toEqual({ error: 'NOT_FOUND' });
  });

  it('a non-POST method is rejected', async () => {
    const r = await handleStoragePlaneRequest(sp, { method: 'GET', path: '/storage/browse', sessionToken: undefined, body: {} });
    expect(r.json).toEqual({ error: 'METHOD_NOT_ALLOWED' });
  });
});
