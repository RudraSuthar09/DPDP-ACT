import { BadRequestException } from '@nestjs/common';
import {
  parseCreateStorageFolder,
  parseCreateStorageRoot,
  parseEntityIdQueryParam,
  parseStorageRedeemPairing,
  parseUpdateStorageRoot,
  parseUpsertStorageMapping,
} from './storage.dto';

describe('parseEntityIdQueryParam — GET /storage/mappings?entityId=... (the exact request that used to crash with a raw Postgres 500)', () => {
  it('accepts a well-formed UUID', () => {
    expect(parseEntityIdQueryParam('22222222-2222-2222-2222-222222222222')).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('rejects a missing entityId', () => {
    expect(() => parseEntityIdQueryParam(undefined)).toThrow(BadRequestException);
    expect(() => parseEntityIdQueryParam('')).toThrow(BadRequestException);
  });

  it('rejects a 64-character subject_ref hash — the exact shape that used to reach Postgres as "invalid input syntax for type uuid"', () => {
    expect(() => parseEntityIdQueryParam('301b34d8a445a51bdeb536e861dc0281beb1e325958368f992819801ef6559a3')).toThrow(
      BadRequestException,
    );
  });
});

describe('parseCreateStorageRoot', () => {
  it('accepts a local root with no gateway device', () => {
    expect(parseCreateStorageRoot({ name: 'DPDP', provider: 'local', rootPath: 'C:\\CompanyData\\DPDP' })).toEqual({
      name: 'DPDP',
      provider: 'local',
      gatewayDeviceId: null,
      rootPath: 'C:\\CompanyData\\DPDP',
    });
  });

  it('defaults to provider "local" when omitted', () => {
    expect(parseCreateStorageRoot({ name: 'DPDP' }).provider).toBe('local');
  });

  it('requires a gatewayDeviceId when provider is "gateway"', () => {
    expect(() => parseCreateStorageRoot({ name: 'DPDP', provider: 'gateway' })).toThrow(BadRequestException);
  });

  it('accepts a gateway root with a device id', () => {
    const result = parseCreateStorageRoot({ name: 'DPDP', provider: 'gateway', gatewayDeviceId: 'device-1' });
    expect(result).toEqual({ name: 'DPDP', provider: 'gateway', gatewayDeviceId: 'device-1', rootPath: null });
  });

  it('rejects a gatewayDeviceId on a "local" root', () => {
    expect(() => parseCreateStorageRoot({ name: 'DPDP', provider: 'local', gatewayDeviceId: 'device-1' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unknown provider', () => {
    expect(() => parseCreateStorageRoot({ name: 'DPDP', provider: 's3' })).toThrow(BadRequestException);
  });

  it('rejects a rootPath that looks like it contains a credential', () => {
    for (const evil of [
      'postgres://user:pass@host/db',
      '\\\\server\\share?password=hunter2',
      'C:\\creds\\api-key.txt api_key=abc',
    ]) {
      expect(() => parseCreateStorageRoot({ name: 'DPDP', rootPath: evil })).toThrow(BadRequestException);
    }
  });

  it('rejects a missing/short name', () => {
    expect(() => parseCreateStorageRoot({ name: 'D' })).toThrow(BadRequestException);
    expect(() => parseCreateStorageRoot({})).toThrow(BadRequestException);
  });
});

describe('parseUpdateStorageRoot', () => {
  it('rejects an attempt to change provider/gatewayDeviceId after creation', () => {
    expect(() => parseUpdateStorageRoot({ name: 'DPDP', provider: 'gateway' })).toThrow(BadRequestException);
    expect(() => parseUpdateStorageRoot({ name: 'DPDP', gatewayDeviceId: 'device-2' })).toThrow(BadRequestException);
  });

  it('accepts a name/rootPath update', () => {
    expect(parseUpdateStorageRoot({ name: 'DPDP Renamed', rootPath: 'D:\\DPDP' })).toEqual({
      name: 'DPDP Renamed',
      rootPath: 'D:\\DPDP',
    });
  });
});

describe('parseCreateStorageFolder', () => {
  it('accepts a top-level folder (no parent)', () => {
    expect(parseCreateStorageFolder({ storageRootId: 'root-1', name: 'Customers' })).toEqual({
      storageRootId: 'root-1',
      parentFolderId: null,
      name: 'Customers',
    });
  });

  it('accepts a nested folder', () => {
    expect(parseCreateStorageFolder({ storageRootId: 'root-1', parentFolderId: 'folder-1', name: 'Consent' })).toEqual({
      storageRootId: 'root-1',
      parentFolderId: 'folder-1',
      name: 'Consent',
    });
  });

  it('requires storageRootId and name', () => {
    expect(() => parseCreateStorageFolder({ name: 'Consent' })).toThrow(BadRequestException);
    expect(() => parseCreateStorageFolder({ storageRootId: 'root-1' })).toThrow(BadRequestException);
  });
});

describe('parseUpsertStorageMapping — the explicit mapping surface', () => {
  const FORM_UUID = '11111111-1111-1111-1111-111111111111';
  const CUSTOMER_UUID = '22222222-2222-2222-2222-222222222222';

  it('accepts an explicit moduleKey/entityId/folderId choice', () => {
    expect(parseUpsertStorageMapping({ moduleKey: 'consent_form', entityId: FORM_UUID, folderId: 'folder-1' })).toEqual({
      moduleKey: 'consent_form',
      entityId: FORM_UUID,
      folderId: 'folder-1',
    });
  });

  it('accepts moduleKey "data_principal" — a customer/data-principal folder association, entityId is the internal customer UUID (never the subject_ref hash)', () => {
    expect(parseUpsertStorageMapping({ moduleKey: 'data_principal', entityId: CUSTOMER_UUID, folderId: 'folder-9' })).toEqual({
      moduleKey: 'data_principal',
      entityId: CUSTOMER_UUID,
      folderId: 'folder-9',
    });
  });

  it('rejects an unknown moduleKey — the allowlist is fixed, never inferred', () => {
    expect(() => parseUpsertStorageMapping({ moduleKey: 'inventory', entityId: FORM_UUID, folderId: 'y' })).toThrow(
      BadRequestException,
    );
  });

  it('requires entityId and folderId', () => {
    expect(() => parseUpsertStorageMapping({ moduleKey: 'consent_form', folderId: 'y' })).toThrow(BadRequestException);
    expect(() => parseUpsertStorageMapping({ moduleKey: 'consent_form', entityId: FORM_UUID })).toThrow(BadRequestException);
  });

  it('rejects a non-UUID entityId with a clean 400 — a 64-character subject_ref hash (or any other non-UUID string) must never reach the database as a raw type error', () => {
    const subjectRefLike = '301b34d8a445a51bdeb536e861dc0281beb1e325958368f992819801ef6559a3';
    expect(() => parseUpsertStorageMapping({ moduleKey: 'data_principal', entityId: subjectRefLike, folderId: 'folder-1' })).toThrow(
      BadRequestException,
    );
    expect(() => parseUpsertStorageMapping({ moduleKey: 'consent_form', entityId: 'not-a-uuid', folderId: 'folder-1' })).toThrow(
      BadRequestException,
    );
  });
});

describe('parseStorageRedeemPairing', () => {
  it('accepts a well-formed redeem body', () => {
    expect(parseStorageRedeemPairing({ nonce: 'a'.repeat(20), storageRootId: 'root-1' })).toEqual({
      nonce: 'a'.repeat(20),
      storageRootId: 'root-1',
    });
  });

  it('rejects a too-short nonce', () => {
    expect(() => parseStorageRedeemPairing({ nonce: 'short', storageRootId: 'root-1' })).toThrow(BadRequestException);
  });

  it('requires storageRootId', () => {
    expect(() => parseStorageRedeemPairing({ nonce: 'a'.repeat(20) })).toThrow(BadRequestException);
  });
});
