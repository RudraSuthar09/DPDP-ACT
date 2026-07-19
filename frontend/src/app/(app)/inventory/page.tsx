'use client';

/**
 * Data Inventory — the active module in this shell. The inventory UI (schema
 * sources, data elements, PII classification) is built in its own dedicated
 * prompt; this is its real, empty home, not a mock. No dummy data is shown —
 * that would misrepresent what exists.
 */
export default function InventoryPage() {
  return (
    <div>
      <h1>Data Inventory</h1>
      <p className="muted">
        Categories of data, purposes, and retention — descriptions, never customer records (I1).
      </p>
      <div className="panel" style={{ marginTop: 16 }}>
        <p style={{ margin: 0 }}>
          This module is active for your pilot. The inventory workspace (manual entry and file
          import via the SchemaSource seam) lands in the next build step.
        </p>
      </div>
    </div>
  );
}
