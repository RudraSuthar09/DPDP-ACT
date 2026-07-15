import { Module } from '@nestjs/common';

/**
 * Data Inventory. Records categories of personal data (descriptions, NOT
 * customer records — I1): guided forms, Excel/CSV import, Indian-lexicon PII
 * classification (human accept/reject), versioning, and the RoPA PDF export —
 * the single highest-leverage feature (FR-INV-09). Data arrives only via the
 * SchemaSource seam (S4), which has no readRows().
 *
 * Requirements: FR-INV-01..11.  Seams: S4.  Invariants: I1, I4.
 * Skeleton only — no providers or controllers yet.
 */
@Module({})
export class InventoryModule {}
