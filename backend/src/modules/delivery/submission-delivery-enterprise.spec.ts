import { randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { SubmissionDeliveryCipher } from './submission-delivery-crypto';
import { SubmissionDeliveryService, enterpriseCopyFilename } from './submission-delivery.service';
import type { ClaimableFilter, SubmissionDeliveryRepository, SubmissionDeliveryRow } from './submission-delivery.repository';
import type { StorageRepository } from '../storage/storage.repository';
import { parseClaimInput } from './submission-delivery.dto';

/**
 * Enterprise per-field consent delivery, backend half: staging a mapped
 * field as an encrypted Enterprise copy in the EXISTING queue, and handing it
 * only to the device that may perform it. In-memory fakes stand in for the
 * two repositories, mirroring their SQL semantics (claimable statuses,
 * attempt counting + the 10-attempt cap, payload nulled on delivery); the
 * cipher is the real one.
 */

const DEVICE = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE = '22222222-2222-4222-8222-222222222222';

class FakeDeliveryRepo {
  rows: SubmissionDeliveryRow[] = [];
  async create(i: { submissionId: string; formId: string; ciphertext: Buffer; iv: Buffer; authTag: Buffer; targetStorageRootId?: string | null }) {
    const row: SubmissionDeliveryRow = {
      id: randomUUID(),
      tenant_id: 't',
      submission_id: i.submissionId,
      form_id: i.formId,
      status: 'pending',
      payload_ciphertext: i.ciphertext,
      payload_iv: i.iv,
      payload_auth_tag: i.authTag,
      claimed_by_device_id: null,
      attempt_count: 0,
      claimed_at: null,
      delivered_at: null,
      failed_at: null,
      last_error: null,
      target_storage_root_id: i.targetStorageRootId ?? null,
      created_at: new Date(Date.now() + this.rows.length),
      updated_at: new Date(),
    };
    this.rows.push(row);
    return row;
  }
  private claimable = (r: SubmissionDeliveryRow) => r.status === 'pending';
  async listClaimable(limit: number) {
    return this.rows.filter(this.claimable).slice(0, limit);
  }
  async listClaimableFor(limit: number, f: ClaimableFilter) {
    return this.rows
      .filter(this.claimable)
      .filter((r) => (r.target_storage_root_id === null && f.central) || (r.target_storage_root_id !== null && f.storageRootIds.includes(r.target_storage_root_id)))
      .slice(0, limit);
  }
  async claim(id: string, deviceId: string) {
    const r = this.rows.find((x) => x.id === id && this.claimable(x));
    if (!r) return null;
    Object.assign(r, { status: 'delivering', claimed_by_device_id: deviceId, attempt_count: r.attempt_count + 1 });
    return r;
  }
  async findClaimedByDevice(id: string, deviceId: string) {
    return this.rows.find((r) => r.id === id && r.claimed_by_device_id === deviceId && r.status === 'delivering') ?? null;
  }
  async markDelivered(id: string) {
    const r = this.rows.find((x) => x.id === id && x.status === 'delivering');
    if (!r) return null;
    Object.assign(r, { status: 'delivered', payload_ciphertext: null, payload_iv: null, payload_auth_tag: null });
    return r;
  }
  async markFailed(id: string, error: string) {
    const r = this.rows.find((x) => x.id === id && x.status === 'delivering');
    if (!r) return null;
    Object.assign(r, { status: r.attempt_count >= 10 ? 'failed' : 'pending', last_error: error });
    return r;
  }
  async latestStatusForSubmissions(ids: string[]) {
    return this.rows.filter((r) => ids.includes(r.submission_id));
  }
}

interface Root { id: string; name: string; provider: 'local' | 'gateway' | 'server'; gateway_device_id: string | null; status: string }
interface Folder { id: string; storage_root_id: string; parent_folder_id: string | null; name: string; status: string }
interface Mapping { id: string; module_key: string; entity_id: string; folder_id: string; status: string }

class FakeStorageRepo {
  roots: Root[] = [];
  folders: Folder[] = [];
  mappings: Mapping[] = [];
  async listRoots() {
    return this.roots.filter((r) => r.status === 'active');
  }
  async findRoot(id: string) {
    return this.roots.find((r) => r.id === id) ?? null;
  }
  async findFolder(id: string) {
    return this.folders.find((f) => f.id === id) ?? null;
  }
  async listAllFoldersForRoot(rootId: string) {
    return this.folders.filter((f) => f.storage_root_id === rootId && f.status === 'active');
  }
  async findMapping(moduleKey: string, entityId: string) {
    return this.mappings.find((m) => m.module_key === moduleKey && m.entity_id === entityId) ?? null;
  }
  async createFolder(i: { storageRootId: string; parentFolderId: string | null; name: string }) {
    const f: Folder = { id: randomUUID(), storage_root_id: i.storageRootId, parent_folder_id: i.parentFolderId, name: i.name, status: 'active' };
    this.folders.push(f);
    return f;
  }
  async upsertMapping(i: { moduleKey: string; entityId: string; folderId: string }) {
    const m: Mapping = { id: randomUUID(), module_key: i.moduleKey, entity_id: i.entityId, folder_id: i.folderId, status: 'active' };
    this.mappings.push(m);
    return m;
  }
  // test helpers
  root(provider: Root['provider'], device: string | null = provider === 'gateway' ? DEVICE : null, name = `root-${this.roots.length}`): Root {
    const r: Root = { id: randomUUID(), name, provider, gateway_device_id: device, status: 'active' };
    this.roots.push(r);
    return r;
  }
  folder(root: Root, name: string, parent: Folder | null = null): Folder {
    const f: Folder = { id: randomUUID(), storage_root_id: root.id, parent_folder_id: parent?.id ?? null, name, status: 'active' };
    this.folders.push(f);
    return f;
  }
  map(fieldId: string, folder: Folder): void {
    this.mappings.push({ id: randomUUID(), module_key: 'consent_form_field', entity_id: fieldId, folder_id: folder.id, status: 'active' });
  }
}

const cipher = new SubmissionDeliveryCipher({ get: () => randomBytes(32).toString('base64') } as unknown as ConfigService);

function setup() {
  const repo = new FakeDeliveryRepo();
  const storage = new FakeStorageRepo();
  const svc = new SubmissionDeliveryService(repo as unknown as SubmissionDeliveryRepository, storage as unknown as StorageRepository, cipher);
  return { repo, storage, svc };
}

const FORM = randomUUID();
const EMAIL = randomUUID();
const PHONE = randomUUID();
const PROOF = randomUUID();

describe('staging Enterprise copies from the existing per-field mapping', () => {
  it('a field mapped to a Gateway-provider folder is staged ENCRYPTED, in its own row for that root; unmapped/local fields are not', async () => {
    const { repo, storage, svc } = setup();
    const gw = storage.root('gateway');
    storage.map(EMAIL, storage.folder(gw, 'Consents'));
    storage.map(PHONE, storage.folder(storage.root('local'), 'Additional Storage')); // browser-local: unchanged path
    const sub = randomUUID();
    const n = await svc.stageEnterpriseCopies({
      submissionId: sub,
      formId: FORM,
      fields: [
        { fieldId: EMAIL, label: 'Email', textValue: 'asha@example.com' },
        { fieldId: PHONE, label: 'Phone', textValue: '9999999999' },
        { fieldId: randomUUID(), label: 'Unmapped', textValue: 'x' },
      ],
    });
    expect(n).toBe(1);
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]!.target_storage_root_id).toBe(gw.id);
    // Never plaintext at rest: neither the value nor its field label is readable.
    expect(repo.rows[0]!.payload_ciphertext!.includes(Buffer.from('asha@example.com'))).toBe(false);
  });

  it('two fields mapped to two different authorized roots -> two independent rows', async () => {
    const { repo, storage, svc } = setup();
    const a = storage.root('gateway');
    const b = storage.root('gateway');
    storage.map(EMAIL, storage.folder(a, 'Email'));
    storage.map(PHONE, storage.folder(b, 'Phone'));
    await svc.stageEnterpriseCopies({
      submissionId: randomUUID(),
      formId: FORM,
      fields: [
        { fieldId: EMAIL, label: 'Email', textValue: 'e' },
        { fieldId: PHONE, label: 'Phone', textValue: 'p' },
      ],
    });
    expect(repo.rows.map((r) => r.target_storage_root_id).sort()).toEqual([a.id, b.id].sort());
  });

  it('removed mappings, removed folders, tombstoned roots and empty values are skipped, never guessed', async () => {
    const { repo, storage, svc } = setup();
    const gw = storage.root('gateway');
    const gone = storage.folder(gw, 'Gone');
    gone.status = 'tombstoned';
    storage.map(EMAIL, gone);
    const dead = storage.root('gateway');
    dead.status = 'tombstoned';
    storage.map(PHONE, storage.folder(dead, 'X'));
    const live = storage.folder(gw, 'Live');
    storage.map(PROOF, live);
    await svc.stageEnterpriseCopies({
      submissionId: randomUUID(),
      formId: FORM,
      fields: [
        { fieldId: EMAIL, label: 'Email', textValue: 'e' },
        { fieldId: PHONE, label: 'Phone', textValue: 'p' },
        { fieldId: PROOF, label: 'Proof', textValue: '   ' },
      ],
    });
    expect(repo.rows).toEqual([]);
  });
});

describe('claiming an Enterprise copy — only the device that may perform it, re-checked now', () => {
  async function staged() {
    const s = setup();
    const gw = s.storage.root('gateway');
    const consents = s.storage.folder(gw, 'Consents');
    const year = s.storage.folder(gw, '2026', consents);
    s.storage.map(EMAIL, year);
    s.storage.map(PROOF, consents);
    const sub = randomUUID();
    await s.svc.stageEnterpriseCopies({
      submissionId: sub,
      formId: FORM,
      fields: [
        { fieldId: EMAIL, label: 'Email', textValue: 'asha@example.com' },
        { fieldId: PROOF, label: 'ID proof', file: { filename: 'aadhaar scan.PDF', contentBase64: Buffer.from('%PDF').toString('base64') } },
      ],
    });
    return { ...s, gw, sub };
  }

  it('the device bound to the root, reporting it as write-authorized, receives folder NAMES + fixed filenames + content', async () => {
    const { svc, gw, sub } = await staged();
    const r = await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] });
    expect(r).toMatchObject({ ready: true, target: 'gateway', storageRootId: gw.id });
    const files = (r as { files: Array<{ path: string[]; filename: string; contentBase64: string }> }).files;
    expect(files.map((f) => f.path)).toEqual([['Consents', '2026'], ['Consents']]);
    expect(files[0]!.filename).toBe(`Email - ${sub} - ${EMAIL}.txt`);
    expect(files[1]!.filename).toBe(`ID proof - ${sub} - ${PROOF}.pdf`);
    expect(Buffer.from(files[0]!.contentBase64, 'base64').toString('utf8')).toBe('asha@example.com');
  });

  it('a device that does NOT report the root (not authorized for writing there) is never offered it', async () => {
    const { svc, repo } = await staged();
    expect(await svc.claim(DEVICE, { central: false, storageRootIds: [] })).toEqual({ ready: false, reason: 'NOTHING_PENDING' });
    expect(repo.rows[0]!.status).toBe('pending'); // untouched — no attempt burned
  });

  it('a root bound to ANOTHER device is refused even if this device claims to have it', async () => {
    const { svc, gw, repo } = await staged();
    gw.gateway_device_id = OTHER_DEVICE;
    expect(await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] })).toEqual({ ready: false, reason: 'NOTHING_PENDING' });
    expect(repo.rows[0]!).toMatchObject({ status: 'pending', last_error: 'DESTINATION_NOT_AVAILABLE', attempt_count: 1 });
  });

  it('a folder the organisation REMOVED after the copy was queued is refused, not written and not redirected', async () => {
    const { svc, gw, repo } = await staged();
    // Exactly what "Remove folder" does centrally (GatewayFolderService.revoke
    // -> StorageService.revokeGatewayRoot): the root is tombstoned, and the
    // queued copy for it already exists. The backend must fail closed here
    // even if the Gateway has not heard about the removal yet and is still
    // asking for work.
    gw.status = 'tombstoned';

    expect(await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] })).toEqual({
      ready: false,
      reason: 'NOTHING_PENDING',
    });

    // No payload was handed out, and the row was never silently pointed at
    // some other folder.
    expect(repo.rows[0]!).toMatchObject({ status: 'pending', last_error: 'DESTINATION_NOT_AVAILABLE' });
    expect(repo.rows[0]!.target_storage_root_id).toBe(gw.id);
    // Retries cannot get past it either: it fails for good rather than
    // eventually landing somewhere.
    for (let i = 0; i < 9; i += 1) await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] });
    expect(repo.rows[0]!.status).toBe('failed');
  });

  it('a target folder removed after submission fails that delivery (retried, then failed), never redirected elsewhere', async () => {
    const { svc, gw, storage, repo } = await staged();
    storage.folders.find((f) => f.name === '2026')!.status = 'tombstoned';
    await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] });
    expect(repo.rows[0]!).toMatchObject({ status: 'pending', last_error: 'DESTINATION_FOLDER_REMOVED' });
    for (let i = 0; i < 9; i += 1) await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] });
    expect(repo.rows[0]!.status).toBe('failed');
  });

  it('a lost acknowledgement: the row is re-offered with the SAME filenames (the agent then finds them already written)', async () => {
    const { svc, gw, repo } = await staged();
    const first = (await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] })) as { files: Array<{ filename: string }> };
    repo.rows[0]!.status = 'pending'; // the stale-claim window elapsed with no ack
    const second = (await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] })) as { files: Array<{ filename: string }> };
    expect(second.files.map((f) => f.filename)).toEqual(first.files.map((f) => f.filename));
  });

  it('ack nulls the payload; status then reads "delivered" for that destination', async () => {
    const { svc, gw, repo, sub } = await staged();
    const r = (await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id] })) as { deliveryId: string };
    expect(await svc.ack(r.deliveryId, DEVICE)).toBe(true);
    expect(repo.rows[0]!).toMatchObject({ status: 'delivered', payload_ciphertext: null, payload_iv: null, payload_auth_tag: null });
    expect((await svc.latestStatuses([sub])).get(sub)).toEqual([{ target: gw.id, status: 'delivered', attemptCount: 1 }]);
  });

  it('an Enterprise ciphertext cannot be decrypted as another destination (AAD binds submission + root)', async () => {
    const { svc, gw, repo } = await staged();
    const other = (svc as unknown as { storageRepo: FakeStorageRepo }).storageRepo.root('gateway');
    repo.rows[0]!.target_storage_root_id = other.id; // tampered routing
    await svc.claim(DEVICE, { central: false, storageRootIds: [gw.id, other.id] });
    expect(repo.rows[0]!.last_error).toBe('PAYLOAD_UNREADABLE');
  });
});

describe('hasCentralDestination — is Central DPDP Storage a destination at all?', () => {
  it('only the Central local root or a server root count; a Gateway location or a per-field root does not', async () => {
    const { svc, storage } = setup();
    expect(await svc.hasCentralDestination()).toBe(false);
    storage.root('gateway');
    storage.root('local', null, 'Additional storage — Email (abcd1234)');
    expect(await svc.hasCentralDestination()).toBe(false);
    storage.root('local', null, 'DPDP Central Storage');
    expect(await svc.hasCentralDestination()).toBe(true);
    const s2 = setup();
    s2.storage.root('server');
    expect(await s2.svc.hasCentralDestination()).toBe(true);
  });
});

describe('Central DPDP Storage delivery is unchanged', () => {
  it('an older agent (empty claim body) is offered Central rows only, never an Enterprise copy', async () => {
    const { svc, storage, repo } = setup();
    const gw = storage.root('gateway');
    storage.map(EMAIL, storage.folder(gw, 'C'));
    await svc.stageEnterpriseCopies({ submissionId: randomUUID(), formId: FORM, fields: [{ fieldId: EMAIL, label: 'Email', textValue: 'e' }] });
    expect(parseClaimInput({})).toEqual({ central: true, storageRootIds: [] });
    expect(await svc.claim(DEVICE, parseClaimInput({}))).toEqual({ ready: false, reason: 'NOTHING_PENDING' });
    expect(repo.rows[0]!.status).toBe('pending');
  });

  it('no Central root configured: a Central row does not block an Enterprise copy queued behind it', async () => {
    const { svc, storage, repo } = setup();
    await repo.create({ submissionId: randomUUID(), formId: FORM, ciphertext: Buffer.alloc(1), iv: Buffer.alloc(12), authTag: Buffer.alloc(16) });
    const gw = storage.root('gateway');
    storage.map(EMAIL, storage.folder(gw, 'C'));
    await svc.stageEnterpriseCopies({ submissionId: randomUUID(), formId: FORM, fields: [{ fieldId: EMAIL, label: 'Email', textValue: 'e' }] });
    expect(await svc.claim(DEVICE, { central: true, storageRootIds: [gw.id] })).toMatchObject({ ready: true, target: 'gateway' });
    // ...and a Central-only agent still gets the familiar "waiting" answer.
    expect(await svc.claim(DEVICE, { central: true, storageRootIds: [] })).toEqual({ ready: false, reason: 'NOT_CONFIGURED' });
  });

  it('the claim body is validated: only UUIDs, bounded', () => {
    expect(() => parseClaimInput({ storageRootIds: ['C:\\Windows'] })).toThrow();
    expect(() => parseClaimInput({ storageRootIds: Array.from({ length: 51 }, () => randomUUID()) })).toThrow();
    expect(parseClaimInput({ central: false, storageRootIds: [DEVICE, DEVICE] })).toEqual({ central: false, storageRootIds: [DEVICE] });
  });
});

describe('enterpriseCopyFilename — unique per submission + field, stable across retries, Gateway-safe', () => {
  const sub = '33333333-3333-4333-8333-333333333333';
  it('a new submission never reuses an earlier name; the same submission+field always does', () => {
    const a = enterpriseCopyFilename({ submissionId: sub, fieldId: EMAIL, label: 'Email', originalFilename: null });
    expect(enterpriseCopyFilename({ submissionId: sub, fieldId: EMAIL, label: 'Email', originalFilename: null })).toBe(a);
    expect(enterpriseCopyFilename({ submissionId: randomUUID(), fieldId: EMAIL, label: 'Email', originalFilename: null })).not.toBe(a);
    expect(enterpriseCopyFilename({ submissionId: sub, fieldId: PHONE, label: 'Email', originalFilename: null })).not.toBe(a); // duplicate labels
  });
  it('no path characters, bounded length, unusual extensions dropped', () => {
    const n = enterpriseCopyFilename({ submissionId: sub, fieldId: EMAIL, label: '../..\\x:y*'.repeat(30), originalFilename: 'a.b.c/evil.EXE' });
    expect(n).not.toMatch(/[\\/:*?"<>|]/);
    expect(n.length).toBeLessThanOrEqual(200);
    expect(enterpriseCopyFilename({ submissionId: sub, fieldId: EMAIL, label: 'Doc', originalFilename: 'scan.tar.gz?x' })).toBe(`Doc - ${sub} - ${EMAIL}`);
  });
});
