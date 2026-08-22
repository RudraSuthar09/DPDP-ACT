import { Module } from '@nestjs/common';
import { DataPrincipalService } from './data-principal.service';
import { DataPrincipalRepository } from './data-principal.repository';

/**
 * The customer/data-principal identity registry — Seam-adjacent to S2
 * (Consent Register) but deliberately its own small module, not folded into
 * `consent`: Grievance, DSR, Breach, and Data Inventory all need to resolve
 * the SAME customer_id from the SAME subject_ref later (R2 — no module
 * reaches into another's tables; every future consumer imports this module
 * and calls DataPrincipalService, never data_principals directly).
 *
 * No controller — nothing calls this from outside the backend yet. The
 * browser never resolves a customer_id itself; it always receives an
 * already-resolved one from whichever module's own submit/create endpoint
 * did the resolving server-side (see ConsentFormsService.submit).
 */
@Module({
  providers: [DataPrincipalService, DataPrincipalRepository],
  exports: [DataPrincipalService],
})
export class DataPrincipalModule {}
