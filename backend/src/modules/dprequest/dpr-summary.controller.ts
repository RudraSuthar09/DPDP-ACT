import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { AllowReadOnly, Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { PersonalDataSummaryService } from './personal-data-summary.service';
import { FulfilmentService } from './fulfilment.service';
import { DprRegisterService } from './dpr-register.service';
import { PurposeLinksService } from './purpose-links.service';
import { asRecord } from './dto';

const DPR_HANDLERS = ['owner', 'dpo', 'compliance_officer', 'grievance_officer'] as const;

/**
 * The staff surface for the two-tier Personal Data Summary (FR-DPR-04/05),
 * fulfilment (FR-DPR-07) and the register export (FR-DPR-06).
 *
 * Split from `dprequest.controller.ts` rather than bolted onto it because the
 * two do genuinely different things: that one is the ticket queue, this one is
 * the assembly and fulfilment machinery. One controller carrying both would be
 * the longest file in the module and the least readable.
 */
@Controller('dprequest')
@UseGuards(TenantGuard)
export class DprSummaryController {
  constructor(
    private readonly summary: PersonalDataSummaryService,
    private readonly fulfilment: FulfilmentService,
    private readonly register: DprRegisterService,
    private readonly links: PurposeLinksService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // --- the purpose mapping Tier 1 depends on (FR-DPR-04) -------------------

  @Get('purpose-links')
  async listLinks() {
    return { links: await this.links.list() };
  }

  /** Scored candidate pairings for a human to accept. Computed on demand and
   *  stored nowhere — a suggestion only becomes a row by being accepted. */
  @Get('purpose-links/suggestions')
  async suggestions() {
    return { suggestions: await this.links.suggest() };
  }

  /**
   * Accept a suggestion, or make a link by hand.
   *
   * The confidence is RE-DERIVED server-side from the two purpose names rather
   * than trusted from the body — the same rule the PII classifier follows. A
   * client that could post its own confidence could record "a human accepted a
   * 0.99 suggestion" for a pairing the platform actually scored 0.36.
   */
  @Post('purpose-links')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('dprequest.purpose_link.created')
  @HttpCode(HttpStatus.CREATED)
  async createLink(@Body() body: unknown) {
    const raw = asRecord(body);
    const consentPurposeId = requireUuid(raw, 'consentPurposeId');
    const inventoryPurposeId = requireUuid(raw, 'inventoryPurposeId');
    return this.links.link(consentPurposeId, inventoryPurposeId);
  }

  @Delete('purpose-links/:id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('dprequest.purpose_link.removed')
  @HttpCode(HttpStatus.OK)
  async removeLink(@Param('id') id: string, @Body() body: unknown) {
    const reason = String(asRecord(body).reason ?? '').trim();
    if (reason.length < 5) {
      throw new BadRequestException('reason must be at least 5 characters.');
    }
    return this.links.unlink(id, reason);
  }

  // --- Tier 1 (FR-DPR-04) ---------------------------------------------------

  /**
   * POST, not GET, and the reason is the S5 audit interceptor: it records
   * non-safe methods only, and assembling somebody's personal data summary is
   * precisely the compliance-significant act the trail exists to catch. The
   * same reasoning made the RoPA and proof-of-consent exports POSTs.
   *
   * @AllowReadOnly alongside @Roles because Auditor is a read-only role and
   * reviewing what a data principal was told is most of what auditing this
   * feature consists of.
   */
  @Post('tickets/:id/personal-data-summary')
  @Roles(...DPR_HANDLERS, 'auditor')
  @AllowReadOnly()
  @Audited('dprequest.summary.assembled')
  @HttpCode(HttpStatus.OK)
  async personalDataSummary(@Param('id') id: string) {
    return this.summary.assemble(id);
  }

  // --- Tier 2 and fulfilment (FR-DPR-05/07) --------------------------------

  /**
   * Ask the client's system for the actual values.
   *
   * The response of this route may contain the data principal's real data — it
   * is relayed from the client and returned to the caller, and it is the ONLY
   * route in the platform of which that is true. Nothing about it is written
   * down; see FulfilmentService's header for the exhaustive account.
   */
  @Post('tickets/:id/fulfilment/values')
  @Roles(...DPR_HANDLERS)
  @Audited('dprequest.fulfilment.values_requested')
  @HttpCode(HttpStatus.OK)
  async requestValues(@Param('id') id: string) {
    return this.fulfilment.requestValues(id, this.tenantContext.getOrThrow().userId);
  }

  @Post('tickets/:id/fulfilment/correction')
  @Roles(...DPR_HANDLERS)
  @Audited('dprequest.fulfilment.correction_requested')
  @HttpCode(HttpStatus.OK)
  async requestCorrection(@Param('id') id: string) {
    return this.fulfilment.requestAction(id, 'correction', this.tenantContext.getOrThrow().userId);
  }

  @Post('tickets/:id/fulfilment/erasure')
  @Roles(...DPR_HANDLERS)
  @Audited('dprequest.fulfilment.erasure_requested')
  @HttpCode(HttpStatus.OK)
  async requestErasure(@Param('id') id: string) {
    return this.fulfilment.requestAction(id, 'erasure', this.tenantContext.getOrThrow().userId);
  }

  /** The persisted half. Compare what comes back here to what the routes above
   *  return: no url, no data. That gap is the invariant, visible over the API. */
  @Get('tickets/:id/fulfilments')
  async listFulfilments(@Param('id') id: string) {
    return { fulfilments: await this.fulfilment.listForTicket(id) };
  }

  // --- register + evidence export (FR-DPR-06) ------------------------------

  @Get('register')
  async registerList() {
    return this.register.list();
  }

  @Post('register/export')
  @Roles(...DPR_HANDLERS, 'auditor')
  @AllowReadOnly()
  @Audited('dprequest.register.exported')
  @HttpCode(HttpStatus.OK)
  async registerExport(): Promise<StreamableFile> {
    const { buffer, filename } = await this.register.export();
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}

function requireUuid(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return value;
}
