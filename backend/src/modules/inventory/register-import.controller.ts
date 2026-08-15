import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited, NoAudit } from '../audit/audited.decorator';
import { RegisterImportService } from './register-import.service';
import { parseCommitInput, parsePreviewInput } from './register-import.dto';

/**
 * CSV/Excel import for the Data Inventory register (FR-INV-02, ingestion path
 * P2), built on Seam S4's FileImport. Two steps: preview (parse, propose a
 * column mapping — no persistence) then commit (validate the confirmed
 * mapping, create register entries through the same versioned/audited path
 * the guided wizard uses — see RegisterImportService).
 *
 * .xlsx files are converted to CSV text client-side (SheetJS, already used by
 * the Mode-B local file viewer) before reaching this endpoint, so the wire
 * contract here stays csvText-only — FileImportSchemaSource never needs to
 * know it came from a spreadsheet.
 */
@Controller('inventory/register/import')
@UseGuards(TenantGuard)
export class RegisterImportController {
  constructor(private readonly imports: RegisterImportService) {}

  /** Parse the header and propose a PII-category mapping. Nothing is persisted. */
  @Post('preview')
  @Roles('owner', 'dpo', 'compliance_officer')
  @NoAudit() // changes nothing and records nothing — a pure parse.
  @HttpCode(HttpStatus.OK)
  async preview(@Body() body: unknown) {
    const { fileName, tableName, csvText } = parsePreviewInput(body);
    const columns = await this.imports.preview(fileName, tableName, csvText);
    return { fileName, tableName, columns };
  }

  /** Validate the confirmed mapping and create one register entry per column. */
  @Post('commit')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.register.imported')
  @HttpCode(HttpStatus.CREATED)
  async commit(@Body() body: unknown) {
    const input = parseCommitInput(body);
    return this.imports.commit(input);
  }
}
