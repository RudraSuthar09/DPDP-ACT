/**
 * "Connected locations" — one read-only VIEW over the two EXISTING registries
 * of places DPDP can reach through infrastructure the client controls:
 *
 *   - data_sources  (GET /data-sources): places DPDP may READ from
 *   - storage_roots (GET /storage/roots): places DPDP may WRITE collected data to
 *
 * There is no third registry and nothing here is persisted. Each capability
 * comes from its own record and is never inferred from the other: a folder
 * that is readable as a data source is NOT shown as writable unless a
 * storage root grants that separately (and vice versa). One Gateway
 * "Manage sources" entry granted "Read and write" produces BOTH records, so
 * the customer authorizes the folder once and sees it here for both uses.
 * Pure helpers; no I/O.
 */
import type { DataSource, StorageRoot } from '@dpdp/shared';
import { decodeGatewayFileHint } from './gateway-file-source';

export type LocationCapability = 'read' | 'write';

/** Whether DPDP can actually reach the location right now — a separate
 *  question from whether it is configured. 'unknown' is honest: the answer
 *  depends on a device/browser/server probe this view may not have. */
export type LocationAvailability = 'available' | 'unavailable' | 'unknown';

export interface ConnectedLocation {
  /** `${kind}:${id}` — stable across both registries. */
  key: string;
  kind: 'data_source' | 'storage_root';
  id: string;
  name: string;
  /** What DPDP is explicitly permitted to do here — exactly one per record. */
  capability: LocationCapability;
  /** How it is reached: through the Gateway, the server's own mount, or this
   *  browser/desktop's local folder. */
  via: 'gateway' | 'server' | 'local';
  /** Human-readable kind, e.g. "Folder", "PostgreSQL", "Storage root". */
  detail: string;
  availability: LocationAvailability;
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  filesystem: 'Network folder',
  csv: 'CSV file',
  excel: 'Excel file',
  postgresql: 'PostgreSQL database',
  mysql: 'MySQL database',
  sqlserver: 'SQL Server database',
};

/** What this view needs to answer "available right now?" without probing
 *  anything itself. Every field is optional: absent means 'unknown'. */
export interface AvailabilityInputs {
  /** The tenant's Gateway device is sending heartbeats. */
  gatewayOnline?: boolean;
  /** The backend/worker can reach the 'server'-provider path (POST
   *  /storage/roots/:id/verify). */
  serverRootAvailable?: boolean;
  /** THIS browser/desktop currently holds permission for the Central local
   *  folder (central-storage.ts's status === 'connected'). */
  localStorageConnected?: boolean;
}

function availabilityFor(via: ConnectedLocation['via'], a: AvailabilityInputs): LocationAvailability {
  const flag = via === 'gateway' ? a.gatewayOnline : via === 'server' ? a.serverRootAvailable : a.localStorageConnected;
  return flag === undefined ? 'unknown' : flag ? 'available' : 'unavailable';
}

/**
 * Readable locations = active, Gateway-connected data sources that are
 * authorized locations in their own right (a folder or a database). A file
 * added through "Select files" lives INSIDE an authorized folder and is not
 * a separate location, so it is left out here.
 * Writable locations = active storage roots that are not a per-field
 * "Additional storage" root created for one form field.
 */
export function connectedLocations(
  sources: readonly DataSource[],
  roots: readonly StorageRoot[],
  availability: AvailabilityInputs = {},
): ConnectedLocation[] {
  const readable: ConnectedLocation[] = sources
    .filter((s) => s.status === 'active' && s.dataAccessMode === 'gateway_connected' && decodeGatewayFileHint(s.connectionHint) === null)
    .map((s) => ({
      key: `data_source:${s.id}`,
      kind: 'data_source',
      id: s.id,
      name: s.name,
      capability: 'read',
      via: 'gateway',
      detail: SOURCE_KIND_LABEL[s.sourceKind] ?? s.sourceKind,
      availability: availabilityFor('gateway', availability),
    }));
  const writable: ConnectedLocation[] = roots
    .filter((r) => r.status === 'active' && !isPerFieldAdditionalRoot(r))
    .map((r) => ({
      key: `storage_root:${r.id}`,
      kind: 'storage_root',
      id: r.id,
      name: r.name,
      capability: 'write',
      via: r.provider,
      detail: r.provider === 'gateway' ? 'Enterprise folder' : r.provider === 'server' ? 'Server folder' : 'Local folder',
      availability: availabilityFor(r.provider, availability),
    }));
  return [...readable, ...writable].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One row per FOLDER, for the customer-facing Sources & Storage table.
 *
 * `connectedLocations` above is one row per GRANT, which is the honest
 * internal picture — read and write are separate records and must never be
 * inferred from one another. But a hotel owner who allowed one folder for
 * reading and writing authorized ONE folder, and sees two identical names
 * with no way to tell which "Remove" removes what. So the view groups the
 * grants of one folder reached the same way, and a single Remove acts on the
 * folder: both grants, together, exactly as they were given.
 *
 * Grouping is by (via, name) — the name is also the label DPDP recorded and
 * the key the removal route takes, so what the customer clicks and what the
 * server revokes are the same thing. Nothing is merged across `via`: a
 * Gateway folder and a local folder that happen to share a name stay separate
 * rows, because they are separate places.
 */
export interface ConnectedFolder {
  key: string;
  /** The folder name — and the label the removal route is keyed by. */
  name: string;
  via: ConnectedLocation['via'];
  /** Every permission granted on this folder, read before write. */
  capabilities: LocationCapability[];
  detail: string;
  availability: LocationAvailability;
  /** The readable data source behind it, for "Choose folder". Null when the
   *  folder is write-only (or is not a browsable source at all). */
  readSourceId: string | null;
  /** Only a Gateway folder can be removed from here: a server mount and this
   *  browser's own local folder are not grants the customer gave per folder,
   *  and are managed where they are configured. */
  removable: boolean;
}

export function connectedFolders(locations: readonly ConnectedLocation[]): ConnectedFolder[] {
  const byFolder = new Map<string, ConnectedFolder>();
  for (const l of locations) {
    const key = `${l.via}:${l.name}`;
    const existing = byFolder.get(key);
    if (!existing) {
      byFolder.set(key, {
        key,
        name: l.name,
        via: l.via,
        capabilities: [l.capability],
        detail: l.detail,
        availability: l.availability,
        readSourceId: l.capability === 'read' && l.kind === 'data_source' ? l.id : null,
        removable: l.via === 'gateway',
      });
      continue;
    }
    if (!existing.capabilities.includes(l.capability)) existing.capabilities.push(l.capability);
    if (l.capability === 'read' && l.kind === 'data_source') existing.readSourceId = l.id;
    // The least optimistic answer wins: a folder is only shown as reachable
    // when every grant on it is.
    if (existing.availability === 'available' && l.availability !== 'available') existing.availability = l.availability;
  }
  for (const f of byFolder.values()) {
    f.capabilities.sort((a, b) => (a === b ? 0 : a === 'read' ? -1 : 1));
  }
  return [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What DPDP may do with a folder, in one plain phrase. */
export function permissionSentence(capabilities: readonly LocationCapability[]): string {
  const read = capabilities.includes('read');
  const write = capabilities.includes('write');
  if (read && write) return 'DPDP can read from it and save into it';
  if (write) return 'DPDP can save into it';
  return 'DPDP can read from it';
}

/** The name prefix central-storage.ts's connectAdditionalStorageForEntity
 *  gives a one-field root ("Additional storage — <field> (<id>)"). Defined
 *  HERE (a pure module) and imported THERE, so both use the same value. */
export const ADDITIONAL_STORAGE_ROOT_PREFIX = 'Additional storage — ';

/** A one-field root is managed on its form's own page, not a general location. */
export function isPerFieldAdditionalRoot(r: Pick<StorageRoot, 'name'>): boolean {
  return r.name.startsWith(ADDITIONAL_STORAGE_ROOT_PREFIX);
}

export function capabilityLabel(c: LocationCapability): string {
  return c === 'read' ? 'Read' : 'Write';
}

export function availabilityLabel(a: LocationAvailability): string {
  return a === 'available' ? 'Available' : a === 'unavailable' ? 'Unavailable' : 'Not checked';
}

export function viaLabel(v: ConnectedLocation['via']): string {
  if (v === 'gateway') return 'DPDP Gateway';
  if (v === 'server') return 'This server';
  return 'This computer';
}

/* A consent-form field's destination list is NOT built here: the field
 * picker (components/DestinationPicker.tsx) offers Central DPDP Storage plus
 * the writable Gateway locations from gateway-destinations.ts's
 * gatewayStorageRoots, and browses them live through the Gateway's own
 * storage plane. */
