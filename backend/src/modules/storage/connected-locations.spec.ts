import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource, StorageRoot } from '@dpdp/shared';

/**
 * Data Sources -> "Connected locations" (frontend logic, run here because
 * the frontend has no unit-test runner; loaded at runtime, outside the
 * backend's rootDir — same pattern as gateway-file-picker.spec.ts).
 */
const FRONTEND = join(__dirname, '..', '..', '..', '..', 'frontend', 'src');
interface Availability {
  gatewayOnline?: boolean;
  serverRootAvailable?: boolean;
  localStorageConnected?: boolean;
}
interface Location {
  key: string;
  kind: string;
  capability: string;
  via: string;
  name: string;
  detail: string;
  availability: string;
}
interface Destination {
  id: string;
  name: string;
  alwaysIncluded: boolean;
  availability: string;
  via: string;
  note?: string;
}
const lib = jest.requireActual(join(FRONTEND, 'lib', 'connected-locations.ts')) as {
  connectedLocations: (s: DataSource[], r: StorageRoot[], a?: Availability) => Location[];
  fieldDestinations: (r: StorageRoot[], a?: Availability) => Destination[];
  isPerFieldAdditionalRoot: (r: { name: string }) => boolean;
  ADDITIONAL_STORAGE_ROOT_PREFIX: string;
  connectedFolders: (l: readonly Location[]) => Folder[];
  permissionSentence: (c: readonly string[]) => string;
};
interface Folder {
  key: string;
  name: string;
  via: string;
  capabilities: string[];
  detail: string;
  availability: string;
  readSourceId: string | null;
  removable: boolean;
}
const pick = jest.requireActual(join(FRONTEND, 'lib', 'gateway-file-source.ts')) as {
  encodeGatewayFileHint: (r: { src: string; dir: string[]; file: string; size: number | null }) => string;
};

const src = (over: Partial<DataSource>): DataSource =>
  ({
    id: 'ds-1',
    name: 'Finance share',
    sourceKind: 'filesystem',
    dataAccessMode: 'gateway_connected',
    status: 'active',
    connectionHint: null,
    ...over,
  }) as DataSource;
const root = (over: Partial<StorageRoot>): StorageRoot => ({
  id: 'sr-1',
  name: 'Enterprise consents',
  provider: 'gateway',
  gatewayDeviceId: 'dev-1',
  rootPath: null,
  status: 'active',
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('connected locations — one view over the two existing registries', () => {
  it('a Gateway data source is READ only; a storage root is WRITE only — never inferred from each other', () => {
    const out = lib.connectedLocations([src({})], [root({})]);
    expect(out.map((l) => [l.kind, l.capability])).toEqual([
      ['storage_root', 'write'],
      ['data_source', 'read'],
    ]);
  });

  it('the same folder name in both registries is two entries with two separate grants, not one merged location', () => {
    const out = lib.connectedLocations([src({ name: 'Shared' })], [root({ name: 'Shared' })]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((l) => l.capability))).toEqual(new Set(['read', 'write']));
  });

  it('leaves out: metadata-only, removed, picked files inside a folder, tombstoned roots, per-field additional roots', () => {
    const picked = pick.encodeGatewayFileHint({ src: 'ds-1', dir: [], file: 'a.csv', size: 1 });
    const out = lib.connectedLocations(
      [
        src({ id: 'm', dataAccessMode: 'metadata_only' }),
        src({ id: 'r', status: 'tombstoned' as DataSource['status'] }),
        src({ id: 'p', sourceKind: 'csv', connectionHint: picked }),
      ],
      [root({ id: 't', status: 'tombstoned' }), root({ id: 'f', provider: 'local', gatewayDeviceId: null, name: `${lib.ADDITIONAL_STORAGE_ROOT_PREFIX}Email (abcd1234)` })],
    );
    expect(out).toEqual([]);
  });

  it('databases are readable locations too; the route to each root is reported as-is', () => {
    const out = lib.connectedLocations(
      [src({ id: 'db', name: 'CRM', sourceKind: 'postgresql' })],
      [root({ id: 'srv', name: 'Server share', provider: 'server', gatewayDeviceId: null }), root({ id: 'loc', name: 'Laptop', provider: 'local', gatewayDeviceId: null })],
    );
    expect(out.map((l) => `${l.name}:${l.capability}:${l.via}`)).toEqual(['CRM:read:gateway', 'Laptop:write:local', 'Server share:write:server']);
  });

  it('the per-field root naming is shared with central-storage.ts, not copied', () => {
    const central = readFileSync(join(FRONTEND, 'lib', 'central-storage.ts'), 'utf8');
    expect(central).toContain('ADDITIONAL_STORAGE_ROOT_PREFIX');
    expect(central).not.toContain("'Additional storage — '");
    expect(lib.isPerFieldAdditionalRoot({ name: `${lib.ADDITIONAL_STORAGE_ROOT_PREFIX}x` })).toBe(true);
  });
});

describe('the unified Sources list reports type and current availability', () => {
  it('labels each location type in customer language, never an internal provider name', () => {
    const out = lib.connectedLocations(
      [src({ id: 'f', name: 'Finance share', sourceKind: 'filesystem' }), src({ id: 'db', name: 'CRM', sourceKind: 'postgresql' })],
      [root({ id: 'g', name: 'Consent copies' }), root({ id: 's', name: 'Server share', provider: 'server', gatewayDeviceId: null })],
    );
    expect(out.map((l) => `${l.name}=${l.detail}`).sort()).toEqual(
      ['CRM=PostgreSQL database', 'Consent copies=Enterprise folder', 'Finance share=Network folder', 'Server share=Server folder'].sort(),
    );
  });

  it('availability comes from the right probe per route, and is "Not checked" when unknown', () => {
    const sources = [src({})];
    const roots = [root({ id: 'g' }), root({ id: 's', provider: 'server', gatewayDeviceId: null }), root({ id: 'l', provider: 'local', gatewayDeviceId: null })];
    const unknown = lib.connectedLocations(sources, roots);
    expect(new Set(unknown.map((l) => l.availability))).toEqual(new Set(['unknown']));

    const known = lib.connectedLocations(sources, roots, { gatewayOnline: false, serverRootAvailable: true, localStorageConnected: true });
    const byVia = Object.fromEntries(known.map((l) => [`${l.kind}:${l.via}`, l.availability]));
    // The Gateway being offline marks BOTH its readable source and its
    // writable location unavailable — one device, one answer.
    expect(byVia['data_source:gateway']).toBe('unavailable');
    expect(byVia['storage_root:gateway']).toBe('unavailable');
    expect(byVia['storage_root:server']).toBe('available');
    expect(byVia['storage_root:local']).toBe('available');
  });

  it('one folder authorized for BOTH reading and writing appears for both uses, from one Gateway authorization', () => {
    // Gateway Setup's "Read and write" grant produces a data_sources row AND
    // a storage_roots row; the customer authorized the folder once.
    const out = lib.connectedLocations([src({ id: 'ds', name: 'Shared drive' })], [root({ id: 'sr', name: 'Shared drive' })], { gatewayOnline: true });
    expect(out.map((l) => l.capability).sort()).toEqual(['read', 'write']);
    expect(new Set(out.map((l) => l.name))).toEqual(new Set(['Shared drive']));
    expect(new Set(out.map((l) => l.availability))).toEqual(new Set(['available']));
  });
});

describe('the destination picker — one browse experience over the EXISTING storage plane', () => {
  const picker = readFileSync(join(FRONTEND, 'components', 'DestinationPicker.tsx'), 'utf8');
  const sessionLib = readFileSync(join(FRONTEND, 'lib', 'gateway-storage-session.ts'), 'utf8');

  it('browses live through the Gateway storage plane — no new endpoint, no second registry', () => {
    expect(sessionLib).toContain('/storage/roots/${storageRootId}/gateway-pairings');
    expect(sessionLib).toContain('/storage/session/establish');
    expect(sessionLib).toContain("'/storage/browse'");
    expect(sessionLib).toContain("'/storage/folder/create'");
    // The storage plane is folders-only; the picker must not try to list files.
    expect(picker).not.toContain('/source/browse');
    expect(picker).not.toContain('/storage/write');
  });

  it('offers ONLY writable locations: it is handed storage roots, never data sources', () => {
    // `locations` is typed StorageRoot[] and the page passes gwRoots
    // (gatewayStorageRoots). A DataSource can never reach this component.
    expect(picker).toMatch(/locations:\s*StorageRoot\[\]/);
    expect(picker).not.toContain('DataSource');
    const form = readFileSync(join(FRONTEND, 'app', '(app)', 'consent', 'forms', '[id]', 'page.tsx'), 'utf8');
    expect(form).toMatch(/locations=\{gwRoots\}/);
    expect(form).toContain('gatewayStorageRoots(allRoots)');
  });

  it('labels an offline Gateway instead of silently offering it, and explains how to authorize one', () => {
    expect(picker).toContain('Gateway offline');
    expect(picker).toContain('DPDP Gateway Setup');
    expect(picker).toMatch(/grant it <strong>Write<\/strong>/);
  });

  it('never asks for an internal ID or a filesystem path, and refuses the location root itself', () => {
    for (const banned of ['storageRootId"', 'Paste the', 'D:\\\\', 'full path']) {
      expect({ banned, present: picker.includes(banned) }).toEqual({ banned, present: false });
    }
    expect(picker).toContain('does not write to its top level');
  });

  it('maps the browsed path to the EXISTING models: storage_folders chain + consent_form_field mapping', () => {
    expect(picker).toContain("'/storage/folders'"); // the central folder record
    expect(picker).toContain('parentFolderId'); // the full parent chain, so nesting resolves
    const form = readFileSync(join(FRONTEND, 'app', '(app)', 'consent', 'forms', '[id]', 'page.tsx'), 'utf8');
    expect(form).toContain("'/storage/mappings'");
    expect(form).toContain("moduleKey: 'consent_form_field'");
  });

  it('creates the real folder on the Gateway BEFORE recording it centrally (never a phantom folder)', () => {
    const create = picker.slice(picker.indexOf('async function onCreateFolder'), picker.indexOf('async function confirmFolder'));
    expect(create).toContain('createStorageFolder');
    expect(create).not.toContain("'/storage/folders'");
  });

  it('a Gateway refusal is reported as an action, never as a path or a raw error', () => {
    expect(sessionLib).toContain('STORAGE_ROOT_NOT_AUTHORIZED');
    expect(sessionLib).toContain('PERMISSION_DENIED');
    expect(sessionLib).toMatch(/pick "Write"/);
  });

  it('read and write stay independent: the storage session is bound to a storage root, not a source', () => {
    expect(sessionLib).toContain('storageRootId');
    expect(sessionLib).not.toContain('sourceId');
  });
});

describe('the simplified UI keeps every existing capability reachable', () => {
  const page = (p: string[]): string => readFileSync(join(FRONTEND, ...p), 'utf8');

  it('the customer page carries NO Gateway machinery, no ids and no provider names', () => {
    // CODE only: this page's own header comment names what it deliberately
    // leaves out, which is prose, not UI.
    const customer = page(['app', '(app)', 'data-sources', 'page.tsx'])
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const banned of [
      'EnterpriseGatewayPanel', // pairing / enrolment code / revoke
      'Enrolment code',
      'API_URL', // the server address
      'lastHeartbeatAt ?', // heartbeat time rendered
      'Gateway source ID',
      'storageRootId',
      'Add a data source', // the manual form
      'dataAccessMode ===', // access-mode jargon in the UI
      'metadata_only',
      'provider',
      'Advanced',
    ]) {
      expect({ banned, present: customer.includes(banned) }).toEqual({ banned, present: false });
    }
  });

  it('the customer page speaks plain language and offers one recovery action', () => {
    const customer = page(['app', '(app)', 'data-sources', 'page.tsx']);
    for (const phrase of ['Connected folders', 'Choose folder', 'Connection available', 'Reconnect required', 'check again']) {
      expect({ phrase, present: customer.includes(phrase) }).toEqual({ phrase, present: true });
    }
  });

  it('every removed control still exists, on the administration page only', () => {
    const admin = page(['components', 'SourceAdministration.tsx']);
    for (const kept of ['EnterpriseGatewayPanel', 'Gateway source ID', 'Add a data source', 'Select files', 'Revoke Gateway', 'Gateway address']) {
      expect({ kept, present: admin.includes(kept) }).toEqual({ kept, present: true });
    }
    // Mounted on /storage, and reachable from Settings — never from the nav.
    expect(page(['app', '(app)', 'storage', 'page.tsx'])).toContain('<SourceAdministration />');
    expect(page(['app', '(app)', 'settings', 'page.tsx'])).toContain('href="/storage"');
    expect(page(['lib', 'nav.ts'])).not.toMatch(/href: '\/storage'/);
  });

  it('browsing a folder is still possible from the customer page, and registers nothing by itself', () => {
    const customer = page(['app', '(app)', 'data-sources', 'page.tsx']);
    expect(customer).toContain('<GatewayFilePicker'); // the existing browser, per folder
    // The page registers nothing: the only thing it POSTs is the revocation
    // behind "Remove folder", which creates no location record — it tombstones
    // the two this folder already had. No create/update route is reachable
    // from here, and browsing on its own still writes nothing.
    const posts = [...customer.matchAll(/apiFetch<[^>]*>\(\s*'([^']+)'\s*,\s*\{\s*\n?\s*method: 'POST'/g)].map((m) => m[1]);
    expect(posts).toEqual(['/gateway/folders/revoke']);
    expect(customer).not.toMatch(/method: '(PUT|PATCH)'/);
  });

  it('Storage keeps Central, Gateway locations, Enterprise Server Storage, browsing and manual sync', () => {
    const storage = page(['app', '(app)', 'storage', 'page.tsx']);
    for (const kept of ['Main storage folder', 'GatewayStorageLocations', 'Enterprise Server Storage', 'Browse storage', 'Sync pending consent submissions']) {
      expect({ kept, present: storage.includes(kept) }).toEqual({ kept, present: true });
    }
  });

  it('the field row has ONE destination action, opening the shared picker', () => {
    const form = page(['app', '(app)', 'consent', 'forms', '[id]', 'page.tsx']);
    expect(form).toContain('Choose destination');
    expect(form).toContain('<DestinationPicker');
    expect(form).toContain("'consent_form_field'"); // the existing mapping key, no new model
    // Choosing Central alone still clears the extra mapping (no orphan copy).
    expect(form).toContain('onRemoveFieldStorage');
  });

  it('ONE navigation entry covers locations, and /storage stays a live route reached from Settings', () => {
    const nav = page(['lib', 'nav.ts']);
    expect(nav).toContain("label: 'Sources & Storage'");
    expect(nav).not.toMatch(/href: '\/storage'/); // not a second nav item...
    expect(page(['app', '(app)', 'settings', 'page.tsx'])).toContain('href="/storage"'); // ...reached from Settings
    expect(page(['app', '(app)', 'storage', 'page.tsx'])).toContain('Gateway &amp; storage administration');
  });

  it('browsing an authorized root registers no data source per file (only the chosen folder is recorded)', () => {
    const picker = readFileSync(join(FRONTEND, 'components', 'DestinationPicker.tsx'), 'utf8');
    expect(picker).not.toContain("'/data-sources'");
  });

  it('no screen still tells a customer to create a source and copy a Gateway source ID', () => {
    // The Gateway registers its own folders now (POST /gateway/folders), so
    // that instruction would send people down a workflow that no longer
    // exists. Customer-facing files only: the administration page keeps the
    // id visible for support.
    const customerFacing = [
      ['components', 'GatewayFilePicker.tsx'],
      ['components', 'DestinationPicker.tsx'],
      ['components', 'ConnectedLocationsPanel.tsx'],
      ['app', '(app)', 'data-sources', 'page.tsx'],
      ['lib', 'gateway-session.ts'],
    ];
    for (const parts of customerFacing) {
      const src = page(parts);
      for (const banned of ['Gateway source ID', 'Enable Gateway', 'create a Filesystem source']) {
        expect({ file: parts.join('/'), banned, present: src.includes(banned) }).toEqual({ file: parts.join('/'), banned, present: false });
      }
    }
    // And the picker's empty state points at the real workflow instead.
    expect(page(['components', 'GatewayFilePicker.tsx'])).toContain('Folders DPDP may use');
  });

  it('Sources & Storage re-reads itself, so a folder approved on the Gateway appears without a reload', () => {
    const customer = page(['app', '(app)', 'data-sources', 'page.tsx']);
    expect(customer).toContain('setInterval');
    expect(customer).toContain('load(true)'); // the quiet refresh, no table flicker
    expect(customer).toContain("document.visibilityState === 'hidden'"); // not while hidden
    expect(customer).toMatch(/>\s*\{loading \? 'Checking…' : 'Refresh'\}/); // and a manual one
  });
});

describe('Enterprise (Gateway) destinations for a form field', () => {
  const dest = jest.requireActual(join(FRONTEND, 'lib', 'gateway-destinations.ts')) as {
    gatewayStorageRoots: (r: StorageRoot[]) => StorageRoot[];
    folderNameProblem: (n: string) => string | null;
  };
  it('only active Gateway-provider roots can be chosen', () => {
    expect(
      dest.gatewayStorageRoots([root({ id: 'g' }), root({ id: 'l', provider: 'local', gatewayDeviceId: null }), root({ id: 't', status: 'tombstoned' })]).map((r) => r.id),
    ).toEqual(['g']);
  });
  it('folder names the Gateway would refuse are caught before saving', () => {
    for (const bad of ['', ' ', '.', '..', 'a/b', 'a\\b', 'C:', 'x*', 'a|b']) expect(dest.folderNameProblem(bad)).not.toBeNull();
    expect(dest.folderNameProblem('Consent copies 2026')).toBeNull();
  });
  it('an existing folder record is reused rather than duplicated (the picker walks the parent chain)', () => {
    const picker = readFileSync(join(FRONTEND, 'components', 'DestinationPicker.tsx'), 'utf8');
    const confirm = picker.slice(picker.indexOf('async function confirmFolder'));
    // Resolve-or-create per segment, matched on root + parent + name + active.
    expect(confirm).toContain('existing.find(');
    expect(confirm).toContain('f.parentFolderId === parentId');
    expect(confirm).toContain("f.status === 'active'");
    expect(confirm).toContain('parentId = leaf.id');
  });
});

describe('removing a connected folder — what the customer sees and can do', () => {
  const page = readFileSync(join(FRONTEND, 'app', '(app)', 'data-sources', 'page.tsx'), 'utf8');

  it('one folder granted read AND write is ONE row with both permissions, not two identical rows', () => {
    const out = lib.connectedFolders(lib.connectedLocations([src({ name: 'Hotel data' })], [root({ name: 'Hotel data' })]));
    expect(out).toHaveLength(1);
    expect(out[0]!.capabilities).toEqual(['read', 'write']);
    expect(lib.permissionSentence(out[0]!.capabilities)).toBe('DPDP can read from it and save into it');
    // The one Remove acts on the folder, so it takes both grants with it.
    expect(out[0]!.removable).toBe(true);
    expect(out[0]!.readSourceId).toBe('ds-1');
  });

  it('two folders with different names stay two rows', () => {
    const out = lib.connectedFolders(
      lib.connectedLocations([src({ id: 'ds-1', name: 'Guest records' })], [root({ id: 'sr-1', name: 'Consent copies' })]),
    );
    expect(out.map((f) => [f.name, f.capabilities])).toEqual([
      ['Consent copies', ['write']],
      ['Guest records', ['read']],
    ]);
  });

  it('only a Gateway folder is removable from here, never a server mount or a local one', () => {
    const out = lib.connectedFolders(lib.connectedLocations([], [root({ provider: 'server', name: 'Server folder' }), root({ id: 'sr-2', provider: 'local', name: 'Main storage folder' })]));
    expect(out.map((f) => [f.name, f.removable])).toEqual([
      ['Main storage folder', false],
      ['Server folder', false],
    ]);
  });

  it('the least optimistic availability wins, so a half-reachable folder is never shown as available', () => {
    const out = lib.connectedFolders(
      lib.connectedLocations([src({ name: 'Hotel data' })], [root({ name: 'Hotel data' })], { gatewayOnline: false }),
    );
    expect(out[0]!.availability).toBe('unavailable');
  });

  it('a name shared across different kinds of place is NOT merged: they are different places', () => {
    const out = lib.connectedFolders(lib.connectedLocations([src({ name: 'Shared' })], [root({ name: 'Shared', provider: 'server' })]));
    expect(out).toHaveLength(2);
  });

  it('the page offers Remove, explains it, and asks before doing it', () => {
    expect(page).toContain("'Removing…' : 'Remove'");
    expect(page).toContain('confirm(');
    expect(page).toContain('danger: true');
    // The explanation the customer reads: what stops working, and what is NOT
    // deleted. No ids, paths, devices or protocol words anywhere in it.
    expect(page).toContain('Your files are not deleted');
    expect(page).toMatch(/will stop until you choose another folder/);
  });

  it('the page keys removal by the folder NAME the customer clicked, never by an id', () => {
    expect(page).toContain("body: { label: folder.name }");
    expect(page).not.toMatch(/body: \{\s*(sourceId|storageRootId|deviceId)/);
  });

  it('an offline Gateway is reported as pending, never as finished', () => {
    expect(page).toContain('res.gatewayPending');
    expect(page).toMatch(/as soon as it reconnects/);
    expect(page).toContain('Removal pending');
  });

  it('a form field whose destination was removed is flagged, not shown as connected', () => {
    const form = readFileSync(join(FRONTEND, 'app', '(app)', 'consent', 'forms', '[id]', 'page.tsx'), 'utf8');
    expect(form).toContain('Destination removed — choose another');
    // It can only know that by also reading the removed locations.
    expect(form).toContain('includeTombstoned=true');
    expect(form).toContain('removedRootIds');
  });
});

describe('the Submissions view shows storage delivery separately from the recorded consent', () => {
  const page = readFileSync(join(FRONTEND, 'app', '(app)', 'consent', 'forms', '[id]', 'page.tsx'), 'utf8');
  it('renders a Storage column from deliveryState, beside the consent answers', () => {
    expect(page).toContain('<th>Consent (recorded)</th>');
    expect(page).toContain('<th>Storage</th>');
    for (const state of ["'delivered'", "'partially_delivered'", "'failed'"]) expect(page).toContain(`case ${state}`);
  });
});
