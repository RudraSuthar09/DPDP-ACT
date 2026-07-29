import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { AllowReadOnly, Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { ConsentService } from './consent.service';
import {
  parseDeriveSubjectRef,
  parsePurposeInput,
  parsePurposeTombstoneInput,
  parseRecordConsent,
  parseSubjectHistoryQuery,
  parseSubjectRefParam,
  parseWithdrawInput,
} from './dto';
import type {
  ConsentEventRow,
  ConsentPurposeRow,
  ConsentPurposeVersionRow,
} from './consent.repository';

/**
 * The Consent Register surface (FR-CON-01/03/05/08).
 *
 * Note what these handlers do NOT contain: any `INSERT` against consent_events,
 * and any consent state machine. Recording an event is `consent.recordConsent(...)`,
 * which goes through the EventSink (S2). "Current status" is a query over the
 * append-only log, not a mutable column anyone flips. The controller's job is
 * to parse and delegate.
 *
 * Purposes (FR-CON-01) are a versioned, tombstoned entity as of Prompt 18 —
 * same list/create/get/update/tombstone shape as RegisterController, just
 * without the guided-form nesting inventory purposes need.
 */
@Controller('consent')
@UseGuards(TenantGuard)
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Post('purposes')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.purpose.created')
  @HttpCode(HttpStatus.CREATED)
  async createPurpose(@Body() body: unknown) {
    const fields = parsePurposeInput(body);
    const { purpose, version } = await this.consent.createPurpose(fields);
    return toDetailResponse(purpose, version);
  }

  /** The purpose register: every purpose's current version. */
  @Get('purposes')
  async listPurposes(@Query('includeTombstoned') includeTombstoned?: string) {
    const rows = await this.consent.listPurposes(includeTombstoned === 'true');
    return {
      purposes: rows.map((p) => ({
        id: p.id,
        status: p.status,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        versionNumber: p.version_number,
        name: p.name,
        description: p.description,
      })),
    };
  }

  /** One purpose, with its full version history. */
  @Get('purposes/:id')
  async findPurpose(@Param('id', ParseUUIDPipe) id: string) {
    const { purpose, versions } = await this.consent.findPurposeDetail(id);
    return {
      id: purpose.id,
      status: purpose.status,
      tombstoneReason: purpose.tombstone_reason,
      tombstonedAt: purpose.tombstoned_at,
      createdAt: purpose.created_at,
      updatedAt: purpose.updated_at,
      versions: versions.map(toVersionResponse),
    };
  }

  /** Edit. Creates a new version — nothing is ever overwritten (I4). */
  @Patch('purposes/:id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.purpose.updated')
  async updatePurpose(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const fields = parsePurposeInput(body);
    const version = await this.consent.updatePurpose(id, fields);
    return toVersionResponse(version);
  }

  /** Soft-delete. Never a hard delete — dpdp_app holds no DELETE grant (I4). */
  @Delete('purposes/:id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.purpose.tombstoned')
  @HttpCode(HttpStatus.OK)
  async tombstonePurpose(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parsePurposeTombstoneInput(body);
    const purpose = await this.consent.tombstonePurpose(id, reason);
    return { id: purpose.id, status: purpose.status, tombstonedAt: purpose.tombstoned_at };
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

  /**
   * Derive the stored (HMAC'd) reference for a customer id, so the timeline UI
   * can then query by that reference instead of putting the raw customer id in
   * a URL — where it would sit in access logs and proxy logs indefinitely,
   * quietly undoing the pseudonymisation it exists to provide (I2).
   *
   * A POST because the id belongs in a body, not a query string; @AllowReadOnly
   * because it is a pure one-way computation that reads and writes nothing, and
   * an Auditor viewing a consent timeline is a legitimate, read-only act.
   */
  @Post('subject-ref')
  @AllowReadOnly()
  @Audited('consent.subject_ref.derived')
  @HttpCode(HttpStatus.OK)
  async subjectRef(@Body() body: unknown) {
    const { customerId } = parseDeriveSubjectRef(body);
    return { subjectRef: await this.consent.deriveSubjectRef(customerId) };
  }

  /**
   * The bitemporal read (FR-CON-05) — full event history plus the status
   * derived from it, for one already-pseudonymised subject. Prompt 21's
   * timeline UI consumes this.
   *
   *   ?asOf=2026-03-03                     what we NOW believe was true then
   *   ?asOf=2026-03-03&knownAs=2026-03-03  what we believed on the day itself
   *
   * Both default to now, which yields the ordinary current-status answer.
   */
  @Get('subjects/:subjectRef/history')
  async subjectHistory(
    @Param('subjectRef') subjectRef: string,
    @Query('asOf') asOf?: string,
    @Query('knownAs') knownAs?: string,
    @Query('limit') limit?: string,
  ) {
    const ref = parseSubjectRefParam(subjectRef);
    const query = parseSubjectHistoryQuery({ asOf, knownAs });
    const parsedLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const { events, statusAsOf } = await this.consent.subjectHistory(ref, query, parsedLimit);
    return {
      subjectRef: ref,
      asOf: query.asOf,
      knownAs: query.knownAs,
      events: events.map(toEventResponse),
      statusAsOf: statusAsOf.map(toStatusResponse),
    };
  }

  /**
   * One-click withdrawal (FR-CON-06): a tenant operator withdraws consent for
   * this subject/purpose. Takes the already-pseudonymised subject reference —
   * never a raw customer id — same containment rule as every other subject
   * route. Writes a brand-new WITHDRAWN event through ConsentService's SAME
   * EventSink path as general ingest (R3); nothing here touches consent_events
   * directly, and nothing UPDATEs the grant it revokes.
   */
  @Post('subjects/:subjectRef/purposes/:purposeId/withdraw')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.event.withdrawn')
  @HttpCode(HttpStatus.CREATED)
  async withdraw(
    @Param('subjectRef') subjectRef: string,
    @Param('purposeId', ParseUUIDPipe) purposeId: string,
    @Body() body: unknown,
  ) {
    const ref = parseSubjectRefParam(subjectRef);
    const { reason } = parseWithdrawInput(body);
    const { receipt, purposeName, wasAlreadyWithdrawn } = await this.consent.withdrawForSubject(
      ref,
      purposeId,
      reason,
    );
    return {
      eventId: receipt.eventId,
      subjectRef: ref,
      purposeId,
      purposeName,
      recordedAt: receipt.recordedAt,
      deduplicated: receipt.deduplicated,
      wasAlreadyWithdrawn,
    };
  }
}

function toEventResponse(e: ConsentEventRow) {
  return {
    id: e.id,
    purposeId: e.purpose_id,
    purposeName: e.purpose_name,
    status: e.status,
    noticeVersionId: e.notice_version_id,
    legacyNoticeVersionRef: e.legacy_notice_version_ref,
    occurredAt: e.occurred_at,
    recordedAt: e.recorded_at,
    source: e.source,
    evidenceHash: e.evidence_hash,
    evidenceHashOrigin: e.evidence_hash_origin,
  };
}

function toStatusResponse(e: ConsentEventRow) {
  return {
    purposeId: e.purpose_id,
    purposeName: e.purpose_name,
    status: e.status,
    noticeVersionId: e.notice_version_id,
    occurredAt: e.occurred_at,
    recordedAt: e.recorded_at,
  };
}

function toDetailResponse(purpose: ConsentPurposeRow, version: ConsentPurposeVersionRow) {
  return {
    ...toVersionResponse(version),
    id: purpose.id,
    status: purpose.status,
    createdAt: purpose.created_at,
    updatedAt: purpose.updated_at,
  };
}

function toVersionResponse(v: ConsentPurposeVersionRow) {
  return {
    versionNumber: v.version_number,
    name: v.purpose_name,
    description: v.description,
    createdAt: v.created_at,
  };
}
