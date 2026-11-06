'use client';

/**
 * The unified "Connected locations" list: every place DPDP may reach, what it
 * is allowed to do there, and whether it can reach it right now — in one
 * table, so a customer authorizes a folder once (in Gateway Setup) and sees
 * it here for both reading and writing.
 *
 * Built entirely from records the page already loads (lib/connected-
 * locations.ts over GET /data-sources + GET /storage/roots) — no new
 * registry, no new endpoint. Authorization still happens where it always
 * did: Gateway Setup on the Gateway computer grants Read/Write/Both, and
 * this view only reports what was granted.
 */
import { useMemo } from 'react';
import type { DataSource, StorageRoot } from '@dpdp/shared';
import {
  availabilityLabel,
  capabilityLabel,
  connectedLocations,
  viaLabel,
  type AvailabilityInputs,
} from '../lib/connected-locations';

export function ConnectedLocationsPanel({
  sources,
  roots,
  availability,
}: {
  sources: DataSource[];
  roots: StorageRoot[];
  availability?: AvailabilityInputs;
}) {
  const locations = useMemo(() => connectedLocations(sources, roots, availability ?? {}), [sources, roots, availability]);
  const readable = locations.filter((l) => l.capability === 'read').length;
  const writable = locations.filter((l) => l.capability === 'write').length;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>Connected locations</h2>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Everything this organisation has authorized DPDP to use: {readable} to read from, {writable} to write to. Reading
        and writing are granted separately, on the Gateway computer in <strong>DPDP Gateway Setup → Manage sources</strong>
        {' '}— DPDP can never give itself access to a folder.
      </p>
      {locations.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
          No locations are connected yet. Pair the DPDP Gateway below, then authorize a folder, file, or database in
          Gateway Setup.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Type</th>
                <th>Reached through</th>
                <th>DPDP may</th>
                <th>Available now</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.key}>
                  <td>{l.name}</td>
                  <td className="muted">{l.detail}</td>
                  <td className="muted">{viaLabel(l.via)}</td>
                  <td>
                    <span className={`badge ${l.capability === 'read' ? 'info' : 'warning'}`}>{capabilityLabel(l.capability)}</span>
                  </td>
                  <td>
                    <span
                      className={`badge ${l.availability === 'available' ? 'success' : l.availability === 'unavailable' ? 'denied' : 'neutral'}`}
                    >
                      {availabilityLabel(l.availability)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
