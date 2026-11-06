/**
 * Enterprise per-field consent delivery, Gateway half — against REAL
 * temporary folders: the administrator's explicit Read / Write / Both grant,
 * its enforcement in this process (data plane vs storage plane), and the
 * delivery poller writing Enterprise copies through the storage plane.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimedGatewayCopy, ClaimedSubmission, GatewayControlPlaneClient } from '../enrollment';
import { ConnectorRegistry, canRead, canWrite, parseSourceConfigEntries } from '../connectors/registry';
import { StorageRegistry, mergeStorageRoots, storageRootsFromSources } from '../storage/registry';
import { startDeliveryPoller, writeGatewayCopy } from './poller';
import { appendPendingSource, applyPendingSources, readSourcesFile } from '../sources-file';

const ROOT_ID = '0b6a6b9e-1d3c-4a71-9c6f-1f0e0d0c0b0a';
const SUB = '7c1e2d3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('Manage sources: an explicit Read / Write / Both grant', () => {
  const folder = 'D:\\Consents';
  const parse = (e: Record<string, unknown>) => parseSourceConfigEntries([e], 'test')[0]!;

  it('an existing entry (no access field) stays READ-only — never silently writable', () => {
    const cfg = parse({ sourceId: 'finance', kind: 'filesystem', roots: [folder] });
    expect([canRead(cfg), canWrite(cfg)]).toEqual([true, false]);
    expect(storageRootsFromSources([cfg])).toEqual([]);
  });

  it('read, write and both mean exactly that', () => {
    const r = parse({ sourceId: 's', kind: 'filesystem', roots: [folder], access: 'read' });
    const w = parse({ sourceId: ROOT_ID, kind: 'filesystem', roots: [folder], access: 'write', storageRootId: ROOT_ID });
    const b = parse({ sourceId: 's', kind: 'filesystem', roots: [folder], access: 'both', storageRootId: ROOT_ID });
    expect([r, w, b].map((c) => [canRead(c), canWrite(c)])).toEqual([
      [true, false],
      [false, true],
      [true, true],
    ]);
    expect(storageRootsFromSources([r, w, b])).toEqual([
      { storageRootId: ROOT_ID, rootPath: folder },
      { storageRootId: ROOT_ID, rootPath: folder },
    ]);
  });

  it('fails closed on anything ambiguous', () => {
    const bad: Array<Record<string, unknown>> = [
      { sourceId: 's', kind: 'filesystem', roots: [folder], access: 'WRITE', storageRootId: ROOT_ID }, // unknown value
      { sourceId: 's', kind: 'filesystem', roots: [folder], access: 'write' }, // no storage location
      { sourceId: 's', kind: 'filesystem', roots: [folder], access: 'write', storageRootId: '../x' }, // bad id
      { sourceId: 's', kind: 'filesystem', roots: [folder, 'E:\\Other'], access: 'both', storageRootId: ROOT_ID }, // which folder?
      { sourceId: 's', kind: 'postgresql', connection: { host: 'h', port: 1, user: 'u', database: 'd' }, access: 'write', storageRootId: ROOT_ID }, // a database
      { sourceId: 's', kind: 'filesystem', roots: [folder], storageRootId: ROOT_ID }, // a storage id without a write grant
    ];
    for (const e of bad) expect(() => parse(e)).toThrow();
  });

  it('the data plane refuses a write-only folder even if it were handed one', () => {
    const w = parse({ sourceId: ROOT_ID, kind: 'filesystem', roots: [folder], access: 'write', storageRootId: ROOT_ID });
    expect(() => new ConnectorRegistry([w]).get(ROOT_ID)).toThrow(/SOURCE_NOT_AUTHORIZED/);
  });

  it('the grant survives the real hand-off: elevated helper queue -> service merge -> sources file -> registries', () => {
    const state = mkdtempSync(join(tmpdir(), 'dpdp-grant-'));
    try {
      appendPendingSource(state, { sourceId: 'finance', kind: 'filesystem', roots: ['D:\\Finance'] });
      appendPendingSource(state, { sourceId: ROOT_ID, kind: 'filesystem', roots: ['D:\\Consents'], access: 'write', storageRootId: ROOT_ID });
      expect(applyPendingSources(state, null)).toBe(2);
      const loaded = readSourcesFile(join(state, 'sources.json'), null).sources;
      expect(loaded.filter(canRead).map((s) => s.sourceId)).toEqual(['finance']);
      expect(storageRootsFromSources(loaded)).toEqual([{ storageRootId: ROOT_ID, rootPath: 'D:\\Consents' }]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('GATEWAY_STORAGE_ROOTS keeps working; a grant for the same location to a DIFFERENT folder is refused, not silently swapped', () => {
    const env = [{ storageRootId: ROOT_ID, rootPath: '/client-storage' }];
    expect(mergeStorageRoots(env, [{ storageRootId: ROOT_ID, rootPath: '/client-storage' }])).toEqual({ roots: env, conflicts: [] });
    expect(mergeStorageRoots(env, [{ storageRootId: ROOT_ID, rootPath: 'D:\\Other' }])).toEqual({ roots: env, conflicts: [ROOT_ID] });
    const other = { storageRootId: '9b6a6b9e-1d3c-4a71-9c6f-1f0e0d0c0b0a', rootPath: 'D:\\X' };
    expect(mergeStorageRoots([], [other]).roots).toEqual([other]);
  });
});

describe('writeGatewayCopy — an Enterprise copy through the storage plane', () => {
  let root: string;
  let registry: StorageRegistry;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-gwcopy-'));
    registry = new StorageRegistry([{ storageRootId: ROOT_ID, rootPath: root }]);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const copy = (files: ClaimedGatewayCopy['files']): ClaimedGatewayCopy => ({ ready: true, target: 'gateway', deliveryId: 'd1', storageRootId: ROOT_ID, files });

  it('writes each field into its mapped folder (created if missing, inside the root only)', async () => {
    const r = await writeGatewayCopy(
      registry,
      copy([
        { path: ['Consents', '2026'], filename: `Email - ${SUB} - f1.txt`, contentBase64: b64('asha@example.com') },
        { path: ['Proofs'], filename: `ID - ${SUB} - f2.pdf`, contentBase64: b64('%PDF') },
      ]),
    );
    expect(r).toEqual({ written: 2, alreadyPresent: 0 });
    expect(readFileSync(join(root, 'Consents', '2026', `Email - ${SUB} - f1.txt`), 'utf8')).toBe('asha@example.com');
    expect(readFileSync(join(root, 'Proofs', `ID - ${SUB} - f2.pdf`), 'utf8')).toBe('%PDF');
  });

  it('a retry of the SAME delivery creates no duplicate and changes nothing', async () => {
    const files = [{ path: ['C'], filename: `Email - ${SUB} - f1.txt`, contentBase64: b64('v1') }];
    await writeGatewayCopy(registry, copy(files));
    expect(await writeGatewayCopy(registry, copy(files))).toEqual({ written: 0, alreadyPresent: 1 });
    expect(readdirSync(join(root, 'C'))).toEqual([`Email - ${SUB} - f1.txt`]);
  });

  it('a NEW submission never overwrites earlier evidence: both files remain', async () => {
    await writeGatewayCopy(registry, copy([{ path: ['C'], filename: `Email - ${SUB} - f1.txt`, contentBase64: b64('first') }]));
    const next = 'aaaaaaaa-1d3c-4a71-9c6f-1f0e0d0c0b0a';
    await writeGatewayCopy(registry, copy([{ path: ['C'], filename: `Email - ${next} - f1.txt`, contentBase64: b64('second') }]));
    expect(readFileSync(join(root, 'C', `Email - ${SUB} - f1.txt`), 'utf8')).toBe('first');
    expect(readFileSync(join(root, 'C', `Email - ${next} - f1.txt`), 'utf8')).toBe('second');
  });

  it('a location this Gateway was not authorized to write to is refused before any filesystem call', async () => {
    const readOnlyOnly = new StorageRegistry([]); // e.g. the folder was granted Read only
    await expect(writeGatewayCopy(readOnlyOnly, copy([{ path: ['C'], filename: 'x.txt', contentBase64: b64('x') }]))).rejects.toMatchObject({
      code: 'STORAGE_ROOT_NOT_AUTHORIZED',
    });
    await expect(writeGatewayCopy(undefined, copy([{ path: ['C'], filename: 'x.txt', contentBase64: b64('x') }]))).rejects.toMatchObject({
      code: 'STORAGE_ROOT_NOT_AUTHORIZED',
    });
  });

  it('paths escaping the authorized root, and unsafe names, are refused; nothing is written outside', async () => {
    await expect(writeGatewayCopy(registry, copy([{ path: ['..', 'escape'], filename: 'x.txt', contentBase64: b64('x') }]))).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    await expect(writeGatewayCopy(registry, copy([{ path: ['C'], filename: 'run.exe', contentBase64: b64('x') }]))).rejects.toMatchObject({
      code: 'INVALID_FILENAME',
    });
    expect(readdirSync(join(root, '..')).includes('escape')).toBe(false);
  });

  it('an existing customer file under an unrelated name is never touched', async () => {
    mkdirSync(join(root, 'C'));
    writeFileSync(join(root, 'C', 'customers.csv'), 'Name\nAsha\n');
    await writeGatewayCopy(registry, copy([{ path: ['C'], filename: `Email - ${SUB} - f1.txt`, contentBase64: b64('v') }]));
    expect(readFileSync(join(root, 'C', 'customers.csv'), 'utf8')).toBe('Name\nAsha\n');
  });
});

describe('the delivery poller with write-authorized locations', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dpdp-gwpoll-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function client(replies: ClaimedSubmission[], ack: () => Promise<{ ok: boolean }> = async () => ({ ok: true })) {
    const claimSubmission = jest.fn();
    for (const r of replies) claimSubmission.mockResolvedValueOnce(r);
    claimSubmission.mockResolvedValue({ ready: false, reason: 'NOTHING_PENDING' });
    return {
      claimSubmission,
      ackSubmission: jest.fn(ack),
      failSubmission: jest.fn(async () => ({ ok: true })),
    } as unknown as GatewayControlPlaneClient & { claimSubmission: jest.Mock; ackSubmission: jest.Mock; failSubmission: jest.Mock };
  }
  const until = async (p: () => boolean): Promise<void> => {
    const start = Date.now();
    while (!p()) {
      if (Date.now() - start > 3000) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const gwCopy: ClaimedGatewayCopy = {
    ready: true,
    target: 'gateway',
    deliveryId: 'd1',
    storageRootId: ROOT_ID,
    files: [{ path: ['Consents'], filename: `Email - ${SUB} - f1.txt`, contentBase64: b64('asha@example.com') }],
  };

  it('with no Central root, it still claims — advertising ONLY its write-authorized locations — writes, then acks', async () => {
    const c = client([gwCopy]);
    const stop = startDeliveryPoller({
      client: c,
      deviceToken: 't',
      pollIntervalSeconds: 60,
      localRootConfig: { electronConfigPath: null, fallbackRoot: null },
      storageRegistry: new StorageRegistry([{ storageRootId: ROOT_ID, rootPath: root }]),
      log: () => {},
    });
    await until(() => c.ackSubmission.mock.calls.length > 0);
    stop();
    expect(c.claimSubmission.mock.calls[0]).toEqual(['t', { central: false, storageRootIds: [ROOT_ID] }]);
    expect(c.ackSubmission).toHaveBeenCalledWith('t', 'd1');
    expect(readFileSync(join(root, 'Consents', `Email - ${SUB} - f1.txt`), 'utf8')).toBe('asha@example.com');
  });

  it('nothing authorized for writing and no Central root: it does not claim at all', async () => {
    const c = client([gwCopy]);
    const stop = startDeliveryPoller({
      client: c,
      deviceToken: 't',
      pollIntervalSeconds: 60,
      localRootConfig: { electronConfigPath: null, fallbackRoot: null },
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(c.claimSubmission).not.toHaveBeenCalled();
  });

  it('a failed write is reported with a path-free code, never acknowledged as stored', async () => {
    const c = client([{ ...gwCopy, files: [{ path: ['..'], filename: 'x.txt', contentBase64: b64('secret-value') }] }]);
    const stop = startDeliveryPoller({
      client: c,
      deviceToken: 't',
      pollIntervalSeconds: 60,
      localRootConfig: { electronConfigPath: null, fallbackRoot: null },
      storageRegistry: new StorageRegistry([{ storageRootId: ROOT_ID, rootPath: root }]),
      log: () => {},
    });
    await until(() => c.failSubmission.mock.calls.length > 0);
    stop();
    expect(c.failSubmission).toHaveBeenCalledWith('t', 'd1', 'PATH_NOT_ALLOWED');
    expect(c.ackSubmission).not.toHaveBeenCalled();
  });

  it('a lost acknowledgement, then the re-offered delivery: one file, then a successful ack', async () => {
    let first = true;
    const c = client([gwCopy, gwCopy], async () => {
      if (first) {
        first = false;
        throw new Error('network down');
      }
      return { ok: true };
    });
    const logs: string[] = [];
    const stop = startDeliveryPoller({
      client: c,
      deviceToken: 't',
      pollIntervalSeconds: 60,
      localRootConfig: { electronConfigPath: null, fallbackRoot: null },
      storageRegistry: new StorageRegistry([{ storageRootId: ROOT_ID, rootPath: root }]),
      log: (l) => logs.push(l),
    });
    await until(() => c.ackSubmission.mock.calls.length >= 2);
    stop();
    expect(readdirSync(join(root, 'Consents'))).toEqual([`Email - ${SUB} - f1.txt`]);
    expect(logs.some((l) => l.includes('written=0 alreadyPresent=1'))).toBe(true);
    // A lost ack is not a failed write: it is never reported as one.
    expect(c.failSubmission).not.toHaveBeenCalled();
    // No value or path ever reaches a log line.
    expect(logs.join('\n')).not.toContain('asha@example.com');
    expect(logs.join('\n')).not.toContain(root);
  });
});
