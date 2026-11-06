/**
 * File picker (/source/browse) — the EXISTING filesystem connector and data
 * plane, against REAL temporary folders. One level at a time, opaque handles,
 * no paths in or out, containment re-checked on every call.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemConnector } from './filesystem-connector';
import { ConnectorRegistry } from './registry';
import { SessionStore } from '../session-store';
import { DataPlane, handleDataPlaneRequest, type ControlPlaneClient } from '../data-plane';

const FUTURE = new Date(Date.now() + 60_000).toISOString();

describe('FilesystemConnector.browse', () => {
  let root: string;
  let outside: string;
  let fs: FilesystemConnector;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-browse-root-'));
    outside = mkdtempSync(join(tmpdir(), 'dpdp-browse-outside-'));
    mkdirSync(join(root, 'Exports', '2024'), { recursive: true });
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'customers.csv'), 'Name\nAsha\n');
    writeFileSync(join(root, 'notes.txt'), 'not an approved type');
    writeFileSync(join(root, 'Exports', 'leads.xlsx'), 'x');
    writeFileSync(join(root, 'Exports', '2024', 'q1.csv'), 'A\n1\n');
    writeFileSync(join(outside, 'secret.csv'), 'S\n1\n');
    fs = new FilesystemConnector('filesystem', [root]);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('top level: folders first, then approved files only; hidden and unapproved entries are not listed', async () => {
    const r = await fs.browse(null);
    expect(r.entries.map((e) => [e.entryKind, e.label])).toEqual([
      ['folder', 'Exports'],
      ['file', 'customers.csv'],
    ]);
    expect(r.entries.find((e) => e.label === 'customers.csv')!.sizeBytes).toBe(10);
    expect(r.truncated).toBe(false);
  });

  it('navigates into folders by opaque handle', async () => {
    const top = await fs.browse(null);
    const exportsDir = await fs.browse(top.entries[0]!.handle);
    expect(exportsDir.entries.map((e) => e.label)).toEqual(['2024', 'leads.xlsx']);
    const y2024 = await fs.browse(exportsDir.entries[0]!.handle);
    expect(y2024.entries.map((e) => e.label)).toEqual(['q1.csv']);
  });

  it('never returns a path: labels are bare names, handles are opaque', async () => {
    const r = await fs.browse(null);
    for (const e of r.entries) {
      expect(e.label).not.toMatch(/[\\/]/);
      expect(e.handle).not.toContain(root);
      expect(Object.keys(e).sort()).toEqual(['entryKind', 'handle', 'label', 'sizeBytes']);
    }
  });

  it('a file found by browsing is readable through the existing read() with the same handle', async () => {
    const file = (await fs.browse(null)).entries.find((e) => e.entryKind === 'file')!;
    const read = await fs.read(file.handle);
    expect(read.headers).toEqual(['Name']);
  });

  it('forged handles fail closed; a folder handle is not readable and a file handle is not browsable', async () => {
    await expect(fs.browse('not-a-real-handle')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    const top = await fs.browse(null);
    const folder = top.entries.find((e) => e.entryKind === 'folder')!;
    const file = top.entries.find((e) => e.entryKind === 'file')!;
    await expect(fs.read(folder.handle)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(fs.browse(file.handle)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('a symlinked folder pointing OUTSIDE the root is not listed (where links can be created)', async () => {
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction');
    } catch {
      return; // creating links can need extra rights; containment is also covered by resolveDirWithinRoots
    }
    try {
      const r = await fs.browse(null);
      expect(r.entries.map((e) => e.label)).not.toContain('escape');
    } finally {
      rmSync(join(root, 'escape'), { force: true, recursive: false });
    }
  });

  it('several roots: the top level shows one folder per root', async () => {
    const two = new FilesystemConnector('filesystem', [join(root, 'Exports'), outside]);
    const r = await two.browse(null);
    expect(r.entries.every((e) => e.entryKind === 'folder')).toBe(true);
    expect(r.entries).toHaveLength(2);
  });

  it('browsing changes nothing on disk', async () => {
    const before = readdirSync(root).sort();
    await fs.browse(null);
    expect(readdirSync(root).sort()).toEqual(before);
  });
});

describe('/source/browse through the data plane (session-bound, like discover)', () => {
  let root: string;
  let dp: DataPlane;
  const control: ControlPlaneClient = { redeemPairing: async () => ({ sessionToken: 'SESSION', expiresAt: FUTURE }) };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-browse-dp-'));
    writeFileSync(join(root, 'a.csv'), 'A\n1\n');
    dp = new DataPlane(
      new ConnectorRegistry([
        { sourceId: 'folder1', kind: 'filesystem', roots: [root] },
        { sourceId: 'db1', kind: 'postgresql', connection: { host: 'h', port: 1, user: 'u', password: 'p', database: 'd' } },
      ]),
      new SessionStore(),
      { tenantId: 'T', deviceId: 'D' },
      control,
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const establish = async (sourceId: string) =>
    ((await handleDataPlaneRequest(dp, { method: 'POST', path: '/session/establish', sessionToken: undefined, body: { sourceId, nonce: 'n' } })).json as {
      sessionToken: string;
    }).sessionToken;

  it('lists the authorized folder with a valid session', async () => {
    const token = await establish('folder1');
    const r = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/browse', sessionToken: token, body: { sourceId: 'folder1' } });
    expect(r.status).toBe(200);
    expect((r.json as { entries: { label: string }[] }).entries.map((e) => e.label)).toEqual(['a.csv']);
  });

  it('requires a session, bound to the same source', async () => {
    expect((await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/browse', sessionToken: undefined, body: { sourceId: 'folder1' } })).status).toBe(401);
    const token = await establish('folder1');
    const r = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/browse', sessionToken: token, body: { sourceId: 'db1' } });
    expect(r).toMatchObject({ status: 403, json: { error: 'SOURCE_MISMATCH' } });
  });

  it('a path, a non-string, or an overlong value is never accepted as a folder handle', async () => {
    const token = await establish('folder1');
    for (const folder of ['C:\\Windows', '../..', 123, 'x'.repeat(200)]) {
      const r = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/browse', sessionToken: token, body: { sourceId: 'folder1', folder } });
      expect([400, 404]).toContain(r.status);
    }
  });

  it('database sources have no folders: UNSUPPORTED_SOURCE', async () => {
    const token = await establish('db1');
    const r = await handleDataPlaneRequest(dp, { method: 'POST', path: '/source/browse', sessionToken: token, body: { sourceId: 'db1' } });
    expect(r).toMatchObject({ status: 404, json: { error: 'UNSUPPORTED_SOURCE' } });
  });
});

describe('GUARD: nothing on the Gateway can delete or move a customer file', () => {
  it('the filesystem connector and its path-safety module contain no delete/rename call', () => {
    for (const f of ['filesystem-connector.ts', 'path-safety.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      for (const banned of ['unlink', 'rmSync', 'rmdir', 'renameSync', 'rename(', 'truncateSync', 'ftruncate']) {
        expect({ f, banned, hit: src.includes(banned) }).toEqual({ f, banned, hit: false });
      }
    }
  });
});
