/**
 * The ONE storage-plane write capability (StorageConnector.writeFile ->
 * /storage/write), against REAL temporary folders. Every rule its contract
 * promises is exercised here: containment, filename validation, size cap,
 * no silent overwrite, atomicity (no temp file left behind), and the same
 * session binding browse/createFolder already use.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATEWAY_AUTH_HEADER } from '@dpdp/shared';
import { GatewayStorageProvider } from './gateway-storage-provider';
import { StorageRegistry } from './registry';
import { StorageSessionStore } from './storage-session-store';
import { StoragePlane, handleStoragePlaneRequest, type StorageControlPlaneClient } from './storage-plane';
import { loadAgentConfig } from '../config';
import { createAgentServer } from '../server';

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64');

describe('GatewayStorageProvider.writeFile', () => {
  let root: string;
  let outside: string;
  let p: GatewayStorageProvider;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-write-root-'));
    outside = mkdtempSync(join(tmpdir(), 'dpdp-write-outside-'));
    mkdirSync(join(root, 'Consents', '2024'), { recursive: true });
    p = new GatewayStorageProvider(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('writes the exact bytes into an existing, contained folder', async () => {
    const r = await p.writeFile(['Consents', '2024'], 'value.txt', b64('Asha'));
    expect(r).toEqual({ written: true, bytesWritten: 4 });
    expect(readFileSync(join(root, 'Consents', '2024', 'value.txt'), 'utf8')).toBe('Asha');
  });

  it('writes binary content unchanged (an uploaded document)', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    await p.writeFile(['Consents'], 'proof.pdf', bytes.toString('base64'));
    expect(readFileSync(join(root, 'Consents', 'proof.pdf')).equals(bytes)).toBe(true);
  });

  it('never creates a folder: a missing target folder fails closed', async () => {
    await expect(p.writeFile(['Consents', 'missing'], 'value.txt', b64('x'))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(readdirSync(join(root, 'Consents')).sort()).toEqual(['2024']);
  });

  it('traversal in the folder path is refused before any filesystem call', async () => {
    for (const path of [['..'], ['Consents', '..', '..'], ['C:\\Windows'], ['a/b'], ['.']]) {
      await expect(p.writeFile(path, 'value.txt', b64('x'))).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    }
  });

  it('unsafe filenames are refused: separators, traversal, NUL, empty, overlong, executables', async () => {
    for (const name of ['../escape.txt', 'a/b.txt', 'a\\b.txt', '..', '.', '', 'x\0.txt', 'x'.repeat(201), 'run.exe', 'RUN.PS1', 'evil.bat', 'link.lnk', 'script.js']) {
      await expect(p.writeFile(['Consents'], name, b64('x'))).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
    }
    expect(readdirSync(join(root, 'Consents')).sort()).toEqual(['2024']);
  });

  it('never silently overwrites: an existing file is refused unless overwrite is explicit', async () => {
    await p.writeFile(['Consents'], 'value.txt', b64('first'));
    await expect(p.writeFile(['Consents'], 'value.txt', b64('second'))).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' });
    expect(readFileSync(join(root, 'Consents', 'value.txt'), 'utf8')).toBe('first');
    await p.writeFile(['Consents'], 'value.txt', b64('second'), true);
    expect(readFileSync(join(root, 'Consents', 'value.txt'), 'utf8')).toBe('second');
  });

  it('a pre-existing customer file the write was not told about is left untouched', async () => {
    writeFileSync(join(root, 'Consents', 'customers.csv'), 'Name\nAsha\n');
    await expect(p.writeFile(['Consents'], 'customers.csv', b64('overwritten'))).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' });
    expect(readFileSync(join(root, 'Consents', 'customers.csv'), 'utf8')).toBe('Name\nAsha\n');
  });

  it('size cap: content over 15 MB is refused with RATE_LIMITED and nothing is written', async () => {
    const big = Buffer.alloc(15 * 1024 * 1024 + 1, 1).toString('base64');
    await expect(p.writeFile(['Consents'], 'big.bin', big)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(readdirSync(join(root, 'Consents')).sort()).toEqual(['2024']);
  });

  it('is atomic: no temp file is ever left behind, on success or on failure', async () => {
    await p.writeFile(['Consents'], 'a.txt', b64('a'));
    await expect(p.writeFile(['Consents'], 'a.txt', b64('b'))).rejects.toBeDefined();
    expect(readdirSync(join(root, 'Consents')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a symlinked folder pointing OUTSIDE the root is not writable (where links can be created)', async () => {
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction');
    } catch {
      return; // creating links can need extra rights; containment is also covered above
    }
    await expect(p.writeFile(['escape'], 'value.txt', b64('x'))).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('concurrent writes of the same new file: exactly one wins, the others are refused, content is whole', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => p.writeFile(['Consents'], 'same.txt', b64(`writer-${i}`))),
    );
    // writeFile's checks and write run synchronously within one call, so on
    // a single agent process these never interleave; the point is that the
    // file always ends up as ONE writer's complete content, never a mix.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(readFileSync(join(root, 'Consents', 'same.txt'), 'utf8')).toMatch(/^writer-\d$/);
  });
});

describe('/storage/write through the storage plane (same session binding as browse)', () => {
  let root: string;
  let sp: StoragePlane;
  const control: StorageControlPlaneClient = { redeemStoragePairing: async () => ({ sessionToken: 'S', expiresAt: FUTURE }) };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-write-sp-'));
    mkdirSync(join(root, 'Consents'));
    sp = new StoragePlane(
      new StorageRegistry([
        { storageRootId: 'root1', rootPath: root },
        { storageRootId: 'root2', rootPath: root },
      ]),
      new StorageSessionStore(),
      { tenantId: 'A', deviceId: 'D' },
      control,
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const establish = async (storageRootId: string) =>
    ((await handleStoragePlaneRequest(sp, { method: 'POST', path: '/storage/session/establish', sessionToken: undefined, body: { storageRootId, nonce: 'n' } }))
      .json as { sessionToken: string }).sessionToken;
  const write = (token: string | undefined, body: Record<string, unknown>) =>
    handleStoragePlaneRequest(sp, { method: 'POST', path: '/storage/write', sessionToken: token, body });

  it('writes with a valid session for that root', async () => {
    const token = await establish('root1');
    const r = await write(token, { storageRootId: 'root1', path: ['Consents'], filename: 'ok.txt', contentBase64: b64('ok') });
    expect(r).toEqual({ status: 200, json: { written: true, bytesWritten: 2 } });
  });

  it('requires a session, bound to the SAME root', async () => {
    expect((await write(undefined, { storageRootId: 'root1', path: ['Consents'], filename: 'x.txt', contentBase64: b64('x') })).status).toBe(401);
    const token = await establish('root1');
    const r = await write(token, { storageRootId: 'root2', path: ['Consents'], filename: 'x.txt', contentBase64: b64('x') });
    expect(r).toMatchObject({ status: 403, json: { error: 'STORAGE_ROOT_MISMATCH' } });
  });

  it('maps write failures to stable codes, never echoing a path', async () => {
    const token = await establish('root1');
    await write(token, { storageRootId: 'root1', path: ['Consents'], filename: 'dup.txt', contentBase64: b64('1') });
    const dup = await write(token, { storageRootId: 'root1', path: ['Consents'], filename: 'dup.txt', contentBase64: b64('2') });
    expect(dup).toEqual({ status: 409, json: { error: 'FILE_ALREADY_EXISTS' } });
    const bad = await write(token, { storageRootId: 'root1', path: ['Consents'], filename: 'x.exe', contentBase64: b64('2') });
    expect(bad).toEqual({ status: 400, json: { error: 'INVALID_FILENAME' } });
    expect(JSON.stringify([dup, bad])).not.toContain(root.replace(/\\/g, '\\\\'));
  });

  it('only a literal `true` overwrites (a truthy string does not)', async () => {
    const token = await establish('root1');
    await write(token, { storageRootId: 'root1', path: ['Consents'], filename: 'o.txt', contentBase64: b64('1') });
    expect((await write(token, { storageRootId: 'root1', path: ['Consents'], filename: 'o.txt', contentBase64: b64('2'), overwrite: 'true' })).status).toBe(409);
    expect((await write(token, { storageRootId: 'root1', path: ['Consents'], filename: 'o.txt', contentBase64: b64('2'), overwrite: true })).status).toBe(200);
  });

  it('malformed bodies are BAD_REQUEST: missing content, non-string filename, non-array path', async () => {
    const token = await establish('root1');
    for (const body of [
      { storageRootId: 'root1', path: ['Consents'], filename: 'x.txt' },
      { storageRootId: 'root1', path: ['Consents'], filename: 7, contentBase64: b64('x') },
      { storageRootId: 'root1', path: 'Consents', filename: 'x.txt', contentBase64: b64('x') },
    ]) {
      expect((await write(token, body)).status).toBe(400);
    }
  });
});

describe('the HTTP server keeps the 4 KB body cap everywhere except /storage/write', () => {
  const ALLOWED = 'https://app.test.example';
  let server: Server;
  let port: number;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-write-http-'));
    mkdirSync(join(root, 'Consents'));
    const config = loadAgentConfig({ GATEWAY_ALLOWED_ORIGINS: ALLOWED });
    const sp = new StoragePlane(
      new StorageRegistry([{ storageRootId: 'root1', rootPath: root }]),
      new StorageSessionStore(),
      { tenantId: 'A', deviceId: 'D' },
      { redeemStoragePairing: async () => ({ sessionToken: 'HTTP-SESSION', expiresAt: FUTURE }) },
    );
    server = createAgentServer(config, { storagePlane: sp });
    await new Promise<void>((r) => server.listen(0, config.bindHost, r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, session?: string): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const headers: Record<string, string> = { origin: ALLOWED, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) };
      if (session) headers[GATEWAY_AUTH_HEADER] = session;
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.end(payload);
    });

  it('a write body well over 4 KB is accepted on /storage/write', async () => {
    const est = await post('/storage/session/establish', { storageRootId: 'root1', nonce: 'n' });
    const token = (est.json as { sessionToken: string }).sessionToken;
    const content = Buffer.alloc(64 * 1024, 7);
    const r = await post('/storage/write', { storageRootId: 'root1', path: ['Consents'], filename: 'doc.bin', contentBase64: content.toString('base64') }, token);
    expect(r).toEqual({ status: 200, json: { written: true, bytesWritten: 64 * 1024 } });
    expect(readFileSync(join(root, 'Consents', 'doc.bin')).equals(content)).toBe(true);
  });

  it('the SAME large body on any other storage route is still refused 413', async () => {
    const r = await post('/storage/browse', { storageRootId: 'root1', path: ['Consents'], pad: 'x'.repeat(64 * 1024) }, 'HTTP-SESSION');
    expect(r.status).toBe(413);
  });
});
