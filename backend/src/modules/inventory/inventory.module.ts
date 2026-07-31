import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { DataElementsRepository } from './data-elements.repository';
import { RegisterController } from './register.controller';
import { RegisterService } from './register.service';
import { RegisterEntriesRepository } from './register-entries.repository';
import { RegisterImportController } from './register-import.controller';
import { RegisterImportService } from './register-import.service';
import { ImportEvidenceStore } from './import-evidence.store';
import { EntryPurposesController } from './entry-purposes.controller';
import { EntryPurposesService } from './entry-purposes.service';
import { EntryPurposesRepository } from './entry-purposes.repository';
import { SystemsController } from './systems.controller';
import { EntrySystemsController } from './entry-systems.controller';
import { SystemsService } from './systems.service';
import { SystemsRepository } from './systems.repository';
import { VendorsController } from './vendors.controller';
import { EntryVendorsController } from './entry-vendors.controller';
import { VendorsService } from './vendors.service';
import { VendorsRepository } from './vendors.repository';
import { DataFlowController } from './data-flow.controller';
import { DataFlowRepository } from './data-flow.repository';
import { SectorTemplatesController } from './sector-templates.controller';
import { SectorTemplatesService } from './sector-templates.service';
import { SectorTemplatesRepository } from './sector-templates.repository';
import { RopaController } from './ropa.controller';
import { RopaService } from './ropa.service';
import { RopaRepository } from './ropa.repository';

/**
 * Data Inventory — Seam S4. Records CATEGORIES of personal data (descriptions,
 * not records — I1) discovered through a SchemaSource: guided forms (ManualEntry)
 * and Excel/CSV import (FileImport), with Indian-lexicon PII classification a
 * human confirms. Data arrives ONLY via SchemaSource, which has no readRows().
 *
 * Also owns the register (FR-INV-01/08): the guided-form entity model — what's
 * collected, why, where it's stored, how long it's retained — with full version
 * history. That is a curated compliance description a human authors, distinct
 * from the structural facts InventoryService discovers via a SchemaSource.
 *
 * Requirements: FR-INV-01..11.  Seams: S4.  Invariants: I1, I4.
 *
 * Unlike S2/S3/S5, S4 needs no write-gating on its table. Its invariant, I1, is
 * enforced one layer up — in the TYPE of the SchemaSource, which cannot express a
 * row read. schema-source.spec.ts pins that no implementation ever grows one.
 * The register's own invariant (I4 — nothing overwritten, nothing hard-deleted)
 * is enforced the same way as identity's users table: dpdp_app holds no DELETE
 * grant, and application code only ever INSERTs a new version row.
 */
@Module({
  imports: [IdentityModule], // RopaService reads organisationName via IdentityService (R2)
  controllers: [
    InventoryController,
    RegisterController,
    RegisterImportController,
    EntryPurposesController,
    SystemsController,
    EntrySystemsController,
    VendorsController,
    EntryVendorsController,
    DataFlowController,
    SectorTemplatesController,
    RopaController,
  ],
  providers: [
    InventoryService,
    DataElementsRepository,
    RegisterService,
    RegisterEntriesRepository,
    RegisterImportService,
    ImportEvidenceStore,
    EntryPurposesService,
    EntryPurposesRepository,
    SystemsService,
    SystemsRepository,
    VendorsService,
    VendorsRepository,
    DataFlowRepository,
    SectorTemplatesService,
    SectorTemplatesRepository,
    RopaService,
    RopaRepository,
  ],
  // RegisterService is exported so the Dashboard module can read the register's
  // element/category counters (FR-DSH-01) through a service interface, never by
  // querying inventory_register_entries directly (R2).
  // RopaService is exported for the DPR Personal Data Summary (FR-DPR-04):
  // it reads the register's current state through a service, never through
  // RopaRepository or the inventory tables directly (R2).
  exports: [RegisterService, RopaService],
})
export class InventoryModule {}
