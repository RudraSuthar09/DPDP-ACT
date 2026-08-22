/**
 * Storage & Folder Mapping — the CONTROL PLANE record of where a tenant's
 * compliance artefacts are filed. See the migration header for the full
 * rationale (Storage Root -> Folder -> Module Mapping).
 *
 * THESE ARE METADATA TYPES ONLY. There is deliberately no field here — and no
 * type anywhere — for a document's content, a customer value, or a secret.
 * `rootPath` is a non-secret local reference, exactly like
 * DataSource.connectionHint; nothing here ever carries what is stored.
 */

/** 'local' = SaaS, a client-selected local/desktop storage location.
 *  'gateway' = Enterprise, storage reached through an already-enrolled
 *  Gateway device. Future providers (e.g. object storage) extend this list
 *  without changing the shape of folders/mappings. */
export const STORAGE_PROVIDERS = ['local', 'gateway'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export type StorageStatus = 'active' | 'tombstoned';

/** The DPDP concepts allowed to own a storage mapping today. Extend this list
 *  (a one-line migration + this array) when a future module needs one.
 *
 *  'data_principal': a customer/data-principal's own folder (locked-arch
 *  Customer Storage foundation). `entityId` for this key MUST be the
 *  internal customer UUID from the data_principals registry
 *  (backend/src/modules/data-principal — `DataPrincipalService.
 *  resolveCustomerId`), NEVER the person's name, email, or any other
 *  personal-data value (I1), and NEVER the 64-character `subject_ref` HMAC
 *  hex digest either — that is a different, EXTERNAL, deterministic
 *  identifier (SubjectRefHasher, I2); this column is `uuid`, subject_ref is
 *  not shaped like one. data_principals.subject_ref -> data_principals.id
 *  is the resolution; every caller receives an already-resolved id, never
 *  derives or guesses one itself.
 *
 *  'consent_form_field': ONE consent form field's own optional additional
 *  local folder (Google-Forms-style field-level storage). `entityId` is that
 *  field's own primary key (consent_form_customer_fields.id) — never a
 *  whole-template mapping; each field configures its own folder
 *  independently, and one field's choice never becomes another's. */
export const STORAGE_MODULE_KEYS = ['consent_form', 'data_principal', 'consent_form_field'] as const;
export type StorageModuleKey = (typeof STORAGE_MODULE_KEYS)[number];

export type StorageMappingStatus = 'active' | 'inactive';

/** A tenant's configured storage location. No value/secret fields, by design. */
export interface StorageRoot {
  id: string;
  name: string;
  provider: StorageProvider;
  /** Set only when provider = 'gateway'. */
  gatewayDeviceId: string | null;
  /** Non-secret path/reference resolved locally — never a credential. */
  rootPath: string | null;
  status: StorageStatus;
  createdAt: string;
  updatedAt: string;
}

/** A virtual folder in a tenant's configured storage hierarchy — structural
 *  metadata only (name + parent), never a file. */
export interface StorageFolder {
  id: string;
  storageRootId: string;
  parentFolderId: string | null;
  name: string;
  status: StorageStatus;
  createdAt: string;
  updatedAt: string;
}

/** Which folder a DPDP module/template files its artefacts into. `entityId`
 *  is the owning module's own primary key (e.g. a consent form's id) —
 *  never dereferenced by the storage module itself (R2). */
export interface StorageMapping {
  id: string;
  moduleKey: StorageModuleKey;
  entityId: string;
  folderId: string;
  status: StorageMappingStatus;
  createdAt: string;
  updatedAt: string;
}
