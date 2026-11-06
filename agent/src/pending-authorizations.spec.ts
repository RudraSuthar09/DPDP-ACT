/**
 * Automatic folder registration, Gateway side: the wizard's approval queue
 * and the service's exchange of it for DPDP record ids. Real files in real
 * temp directories; the control plane is a fake, as elsewhere.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PENDING_AUTHORIZATIONS_FILE_NAME,
  PendingAuthorizationsError,
  appendPendingAuthorization,
  clearPendingAuthorizations,
  readPendingAuthorizations,
} from './pending-authorizations';
import { applyPendingAuthorizations } from './startup-tasks';
import { readSourcesFile } from './sources-file';
import { canRead, canWrite } from './connectors/registry';
import { storageRootsFromSources } from './storage/registry';
import { parseAuthorizeFolderInput } from './cli-pair';
import type { GatewayControlPlaneClient } from './enrollment';

const TOKEN = 'header.payload.signature';

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dpdp-auth-'));
}

function client(
  impl: (input: { label: string; access: string }) => Promise<{ sourceId: string | null; storageRootId: string | null; label: string }>,
): GatewayControlPlaneClient & { calls: Array<{ label: string; access: string }> } {
  const calls: Array<{ label: string; access: string }> = [];
  return {
    authorizeFolder: async (_token: string, input: { label: string; access: 'read' | 'write' | 'both' }) => {
      calls.push(input);
      return impl(input);
    },
    calls,
  } as unknown as GatewayControlPlaneClient & { calls: Array<{ label: string; access: string }> };
}

describe('the approval queue (written by the elevated helper, read by the service)', () => {
  let state: string;
  beforeEach(() => {
    state = dir();
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  it('round-trips a folder, and carries NO id — DPDP generates those', () => {
    expect(appendPendingAuthorization(state, { root: 'D:\\Guests', label: 'Guests', access: 'both' })).toBe(1);
    expect(readPendingAuthorizations(state)).toEqual([{ root: 'D:\\Guests', label: 'Guests', access: 'both' }]);
    const raw = readFileSync(path.join(state, PENDING_AUTHORIZATIONS_FILE_NAME), 'utf8');
    for (const forbidden of ['sourceId', 'storageRootId', 'deviceToken', 'tenantId']) {
      expect({ forbidden, present: raw.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it('re-approving the SAME folder supersedes it instead of queueing twice', () => {
    appendPendingAuthorization(state, { root: 'D:\\Guests', label: 'Guests', access: 'read' });
    appendPendingAuthorization(state, { root: 'd:\\guests', label: 'Guests', access: 'both' }); // same path, different case
    const queued = readPendingAuthorizations(state);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.access).toBe('both');
  });

  it('refuses a relative path, an empty label, or an unknown permission', () => {
    for (const bad of [
      { root: 'Guests', label: 'Guests', access: 'read' as const },
      { root: 'D:\\Guests', label: '   ', access: 'read' as const },
      { root: 'D:\\Guests', label: 'Guests', access: 'admin' as unknown as 'read' },
    ]) {
      expect(() => appendPendingAuthorization(state, bad)).toThrow(PendingAuthorizationsError);
    }
  });

  it('a corrupt queue is reported, never silently treated as empty', () => {
    writeFileSync(path.join(state, PENDING_AUTHORIZATIONS_FILE_NAME), '{not json');
    expect(() => readPendingAuthorizations(state)).toThrow(PendingAuthorizationsError);
  });

  it('an absent queue is simply empty, and clearing an absent queue is harmless', () => {
    expect(readPendingAuthorizations(state)).toEqual([]);
    expect(() => clearPendingAuthorizations(state)).not.toThrow();
  });

  it('the wizard hand-off defaults the label to the folder NAME, never its path', () => {
    expect(parseAuthorizeFolderInput({ root: 'D:\\Hotel\\Guest records\\', access: 'both' })).toEqual({
      root: 'D:\\Hotel\\Guest records',
      label: 'Guest records',
      access: 'both',
    });
    // A label that would be path-like is sanitized before it can be sent.
    expect(parseAuthorizeFolderInput({ root: '\\\\srv\\share\\x', access: 'read', label: 'a/b:c' }).label).toBe('a_b_c');
    // A drive root keeps its separator: "D:" alone is a RELATIVE location.
    expect(parseAuthorizeFolderInput({ root: 'D:\\', access: 'read', label: 'Disk D' }).root).toBe('D:\\');
    for (const bad of [{ root: 'relative', access: 'read' }, { root: 'D:\\x', access: 'nope' }, {}]) {
      expect(() => parseAuthorizeFolderInput(bad)).toThrow();
    }
  });
});

describe('the service exchanges approvals for DPDP ids', () => {
  let state: string;
  let sourcesFilePath: string;
  beforeEach(() => {
    state = dir();
    sourcesFilePath = path.join(state, 'sources.json');
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  const run = (c: GatewayControlPlaneClient | null, deviceToken: string | null = TOKEN) =>
    applyPendingAuthorizations({ stateDir: state, sourcesFilePath, protector: null, client: c, deviceToken, log: () => {} });

  it('read-only: writes a readable source under the id DPDP returned, and no write grant', async () => {
    appendPendingAuthorization(state, { root: 'D:\\Guests', label: 'Guests', access: 'read' });
    const c = client(async () => ({ sourceId: 'src-1', storageRootId: null, label: 'Guests' }));
    expect(await run(c)).toEqual({ applied: 1, pending: 0 });

    const [entry] = readSourcesFile(sourcesFilePath, null).sources;
    expect(entry).toMatchObject({ sourceId: 'src-1', kind: 'filesystem', roots: ['D:\\Guests'], access: 'read' });
    expect([canRead(entry!), canWrite(entry!)]).toEqual([true, false]);
    expect(storageRootsFromSources([entry!])).toEqual([]);
    // The local path is never sent; only the label and the permission.
    expect(c.calls).toEqual([{ label: 'Guests', access: 'read' }]);
  });

  it('write-only: keyed by the storage location id, writable, and NOT readable', async () => {
    appendPendingAuthorization(state, { root: 'D:\\Consents', label: 'Consents', access: 'write' });
    await run(client(async () => ({ sourceId: null, storageRootId: 'root-9', label: 'Consents' })));

    const [entry] = readSourcesFile(sourcesFilePath, null).sources;
    expect(entry).toMatchObject({ sourceId: 'root-9', storageRootId: 'root-9', access: 'write' });
    expect([canRead(entry!), canWrite(entry!)]).toEqual([false, true]);
    expect(storageRootsFromSources([entry!])).toEqual([{ storageRootId: 'root-9', rootPath: 'D:\\Consents' }]);
  });

  it('both: ONE local entry serving both planes, from one approval', async () => {
    appendPendingAuthorization(state, { root: 'D:\\Hotel', label: 'Hotel', access: 'both' });
    await run(client(async () => ({ sourceId: 'src-2', storageRootId: 'root-2', label: 'Hotel' })));

    const { sources } = readSourcesFile(sourcesFilePath, null);
    expect(sources).toHaveLength(1);
    expect([canRead(sources[0]!), canWrite(sources[0]!)]).toEqual([true, true]);
    expect(storageRootsFromSources(sources)).toEqual([{ storageRootId: 'root-2', rootPath: 'D:\\Hotel' }]);
  });

  it('the queue is emptied only for folders DPDP accepted; the rest stay for the next start', async () => {
    appendPendingAuthorization(state, { root: 'D:\\Good', label: 'Good', access: 'read' });
    appendPendingAuthorization(state, { root: 'D:\\Bad', label: 'Bad', access: 'read' });
    const c = client(async ({ label }) => {
      if (label === 'Bad') throw new Error('refused');
      return { sourceId: 'src-good', storageRootId: null, label };
    });
    expect(await run(c)).toEqual({ applied: 1, pending: 1 });
    expect(readPendingAuthorizations(state).map((e) => e.label)).toEqual(['Bad']);
    // The accepted one is already serving — a later failure cannot undo it.
    expect(readSourcesFile(sourcesFilePath, null).sources.map((s) => s.sourceId)).toEqual(['src-good']);
  });

  it('nothing is attempted while unpaired, and nothing is lost', async () => {
    appendPendingAuthorization(state, { root: 'D:\\Guests', label: 'Guests', access: 'read' });
    expect(await run(null, null)).toEqual({ applied: 0, pending: 1 });
    expect(await run(client(async () => ({ sourceId: 's', storageRootId: null, label: 'x' })), null)).toEqual({ applied: 0, pending: 1 });
    expect(readPendingAuthorizations(state)).toHaveLength(1);
  });

  it('an empty queue does nothing at all — no call, no file written', async () => {
    const c = client(async () => ({ sourceId: 's', storageRootId: null, label: 'x' }));
    expect(await run(c)).toEqual({ applied: 0, pending: 0 });
    expect(c.calls).toEqual([]);
    expect(() => readFileSync(sourcesFilePath, 'utf8')).toThrow();
  });

  it('re-approving an already-registered folder updates it in place, never duplicating', async () => {
    appendPendingAuthorization(state, { root: 'D:\\Hotel', label: 'Hotel', access: 'read' });
    await run(client(async () => ({ sourceId: 'src-3', storageRootId: null, label: 'Hotel' })));
    appendPendingAuthorization(state, { root: 'D:\\Hotel', label: 'Hotel', access: 'both' });
    await run(client(async () => ({ sourceId: 'src-3', storageRootId: 'root-3', label: 'Hotel' })));

    const { sources } = readSourcesFile(sourcesFilePath, null);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ sourceId: 'src-3', access: 'both', storageRootId: 'root-3' });
  });
});
