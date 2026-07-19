import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { ConsentService } from './consent.service';
import { parseCreatePurpose, parseRecordConsent } from './dto';

/**
 * The Consent Register surface (FR-CON-01/03/05/08).
 *
 * Note what these handlers do NOT contain: any `INSERT`, and any consent state
 * machine. Recording an event is `consent.recordConsent(...)`, which goes through
 * the EventSink (S2). "Current status" is a query over the append-only log, not a
 * mutable column anyone flips. The controller's job is to parse and delegate.
 */
@Controller('consent')
@UseGuards(TenantGuard)
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /** Define a consent purpose (FR-CON-01). */
  @Post('purposes')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.purpose.created')
  @HttpCode(HttpStatus.CREATED)
  async createPurpose(@Body() body: unknown) {
    const { name } = parseCreatePurpose(body);
    return this.consent.createPurpose(name);
  }

  @Get('purposes')
  async listPurposes() {
    return { purposes: await this.consent.listPurposes() };
  }

  /**
   * Record a consent event (FR-CON-03). The action name defaults here and is
   * refined by the service to withdrawn vs recorded — so the audit log reads
   * true whichever it was.
   */
  @Post('events')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.event.recorded')
  @HttpCode(HttpStatus.CREATED)
  async record(@Body() body: unknown) {
    const { receipt, subjectRef, purposeName } = await this.consent.recordConsent(
      parseRecordConsent(body),
    );
    return {
      eventId: receipt.eventId,
      subjectRef,
      purposeName,
      recordedAt: receipt.recordedAt,
      // Surfaced so a retrying caller can SEE its replay was absorbed, not doubled.
      deduplicated: receipt.deduplicated,
    };
  }

  /**
   * A subject's consent history (FR-CON-08). The caller passes the client's own
   * customer id; it is pseudonymised server-side and never stored (I2). Newest
   * first — the append-only log read straight back.
   */
  @Get('events')
  async history(
    @Query('customerId') customerId?: string,
    @Query('purposeId') purposeId?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return {
      events: await this.consent.history(
        (customerId ?? '').trim(),
        purposeId?.trim() || null,
        parsedLimit,
      ),
    };
  }

  /** The subject's current consent per purpose — a query, not a stored status. */
  @Get('status')
  async status(@Query('customerId') customerId?: string) {
    return { status: await this.consent.currentStatus((customerId ?? '').trim()) };
  }
}
