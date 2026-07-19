import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { DataElementsRepository } from './data-elements.repository';

/**
 * Data Inventory — Seam S4. Records CATEGORIES of personal data (descriptions,
 * not records — I1) discovered through a SchemaSource: guided forms (ManualEntry)
 * and Excel/CSV import (FileImport), with Indian-lexicon PII classification a
 * human confirms. Data arrives ONLY via SchemaSource, which has no readRows().
 *
 * Requirements: FR-INV-01..11.  Seams: S4.  Invariants: I1, I4.
 *
 * Unlike S2/S3/S5, S4 needs no write-gating on its table. Its invariant, I1, is
 * enforced one layer up — in the TYPE of the SchemaSource, which cannot express a
 * row read. schema-source.spec.ts pins that no implementation ever grows one.
 */
@Module({
  controllers: [InventoryController],
  providers: [InventoryService, DataElementsRepository],
})
export class InventoryModule {}
