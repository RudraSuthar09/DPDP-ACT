import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { RetentionService } from './retention.service';

const MANAGE = ['owner', 'dpo', 'compliance_officer'] as const;

/**
 * Retention tracking staff surface. Read routes list what is approaching or past
 * retention (pseudonymised references + metadata only — never a customer value).
 * The platform surfaces; it does not delete the client's data (I1).
 */
@Controller('consent/retention')
@UseGuards(TenantGuard)
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('summary')
  async summary() {
    return this.retention.summary();
  }

  @Get()
  async list(@Query('filter') filter?: string) {
    const f = filter === 'past' || filter === 'all' ? filter : 'approaching';
    return { filter: f, records: await this.retention.list(f) };
  }

  /** The non-consent start path: record a collection date for a subject under an
   *  inventory purpose that has no consent event. */
  @Post('collection')
  @Roles(...MANAGE)
  @Audited('consent.retention.collection_recorded')
  @HttpCode(HttpStatus.CREATED)
  async recordCollection(@Body() body: unknown) {
    const obj = (body ?? {}) as Record<string, unknown>;
    const customerId = String(obj.customerId ?? '').trim();
    const inventoryPurposeId = String(obj.inventoryPurposeId ?? '').trim();
    const collectionDate = String(obj.collectionDate ?? '').trim();
    if (!customerId || !inventoryPurposeId || !collectionDate) {
      throw new BadRequestException('customerId, inventoryPurposeId and collectionDate are required.');
    }
    if (Number.isNaN(Date.parse(collectionDate))) {
      throw new BadRequestException('collectionDate must be a valid date.');
    }
    return this.retention.recordCollection({ customerId, inventoryPurposeId, collectionDate });
  }

  @Post(':id/review')
  @Roles(...MANAGE)
  @Audited('consent.retention.reviewed')
  @HttpCode(HttpStatus.OK)
  async review(@Param('id') id: string, @Body() body: unknown) {
    const note = String((body as { note?: unknown } | null)?.note ?? '').trim() || null;
    const updated = await this.retention.markReviewed(id, note);
    return { id: updated.id, status: updated.status };
  }
}
