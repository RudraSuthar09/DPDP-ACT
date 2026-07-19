import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { InventoryService } from './inventory.service';
import { parseDiscover } from './inventory.dto';

/**
 * Data Inventory surface (FR-INV). Discovery goes through the SchemaSource seam
 * (S4): the controller parses which KIND of source to build, and the service
 * walks it. There is no endpoint — and no interface method — that returns a
 * customer record, because there is no readRows() to expose (I1).
 */
@Controller('inventory')
@UseGuards(TenantGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /** Discover schema metadata from a ManualEntry declaration or a FileImport. */
  @Post('discover')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.schema.discovered')
  @HttpCode(HttpStatus.CREATED)
  async discover(@Body() body: unknown) {
    const { input, sourceRef } = parseDiscover(body);
    const { discovered, elements } = await this.inventory.discover(input, sourceRef);
    return {
      sourceKind: input.kind,
      discovered,
      elements: elements.map((e) => ({
        schema: e.schemaName,
        table: e.tableName,
        column: e.columnName,
        type: e.dataType,
        piiSuggestion: e.piiCategory,
      })),
    };
  }

  /** The tenant's data element register (names/types only — never records). */
  @Get('data-elements')
  async list() {
    return { elements: await this.inventory.list() };
  }
}
