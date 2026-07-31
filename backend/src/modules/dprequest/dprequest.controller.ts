import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { parseLadder } from '../request/request-sla-policy';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { parseStatusFilter } from '../request/dto';
import { DPRequestService } from './dprequest.service';
import { asRecord, parseRightType, parseRightTypeFilter, parseSubjectResolution } from './dto';

/** Same reasoning as `GRIEVANCE_HANDLERS`: a local constant, not an import from
 *  the substrate — the substrate deliberately does not hand out a "who may
 *  handle a ticket" list for specialising modules to inherit. DPR's answer
 *  happens to match Grievance's today. */
const DPR_HANDLERS = ['owner', 'dpo', 'compliance_officer', 'grievance_officer'] as const;

/**
 * The STAFF surface of the Data Principal Request Tracker (FR-DPR-01/02/03/06).
 *
 * Everything generic still goes through `/requests/*` — assign, status,
 * correspondence, identity-verification, escalate all live in
 * `request.controller.ts`, unmodified and shared with Grievance. This
 * controller adds only what is genuinely DPR's: the rights-typed queue, the
 * subject-reference resolution, and the versioned statutory deadlines.
 */
@Controller('dprequest')
@UseGuards(TenantGuard)
export class DPRequestController {
  constructor(private readonly dprequest: DPRequestService) {}

  @Get('deadline-policies')
  async deadlinePolicies() {
    return { policies: await this.dprequest.deadlinePolicies() };
  }

  /**
   * Supersede a statutory deadline. POST, and audited, because it is the single
   * most consequential configuration change in this module: it decides how long
   * every future request of that type gets. Restricted to owner/DPO for the
   * same reason `PUT /requests/sla-policies` is.
   */
  @Post('deadline-policies/:rightType')
  @Roles('owner', 'dpo')
  @Audited('dprequest.deadline_policy.superseded')
  @HttpCode(HttpStatus.CREATED)
  async supersedeDeadline(@Param('rightType') rightType: string, @Body() body: unknown) {
    const raw = asRecord(body);
    const slaSeconds = Number(raw.slaSeconds);
    if (!Number.isInteger(slaSeconds) || slaSeconds < 60 || slaSeconds > 31_536_000) {
      throw new BadRequestException('slaSeconds must be an integer between 60 and 31536000.');
    }
    const note = typeof raw.note === 'string' ? raw.note.trim() : '';
    if (note.length < 10 || note.length > 1000) {
      throw new BadRequestException(
        'note must be 10-1000 characters: a statutory deadline with no stated basis is exactly ' +
          'what the versioned record exists to prevent.',
      );
    }
    // Future-dating is the normal case, not the exception — see
    // deadline_policy_versions.effective_from.
    const effectiveFrom = raw.effectiveFrom ? new Date(String(raw.effectiveFrom)) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('effectiveFrom must be an ISO-8601 timestamp.');
    }

    return this.dprequest.supersedeDeadline(parseRightType({ rightType }), {
      slaSeconds,
      ladder: parseLadder(raw.ladder),
      effectiveFrom,
      note,
    });
  }

  @Get('tickets')
  async list(
    @Query('status') status?: string,
    @Query('rightType') rightType?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return {
      tickets: await this.dprequest.list({
        status: parseStatusFilter(status),
        rightType: parseRightTypeFilter(rightType),
        limit: Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 50,
      }),
    };
  }

  @Get('tickets/:id')
  async detail(@Param('id') id: string) {
    return this.dprequest.detail(id);
  }

  /**
   * FR-DPR-02. The one route in the platform, outside the Consent SDK, that
   * accepts a client's raw customer id — and it is a POST that stores only the
   * HMAC of it. See `DPRequestService.resolveSubjectRef` for the I2 argument in
   * full; note here only that the response contains the digest, never the input,
   * so even a caller who logs the response body cannot leak the id back.
   */
  @Post('tickets/:id/subject-reference')
  @Roles(...DPR_HANDLERS)
  @Audited('dprequest.subject_reference.resolved')
  @HttpCode(HttpStatus.OK)
  async resolveSubjectRef(@Param('id') id: string, @Body() body: unknown) {
    return this.dprequest.resolveSubjectRef(id, parseSubjectResolution(body));
  }
}
