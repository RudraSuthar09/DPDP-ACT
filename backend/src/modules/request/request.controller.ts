import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { RequestService } from './request.service';
import {
  parseAssign,
  parseChangeStatus,
  parseCompleteIdentityVerification,
  parseManualEscalation,
  parseRequestTypeFilter,
  parseSetSlaPolicy,
  parseStaffCorrespondence,
  parseStatusFilter,
} from './dto';

/** Who may work requests. Grievance Officer is here because handling complaints
 *  is literally the role's job (FR-IDN-04); Auditor and Viewer are not, and the
 *  global read-only floor already refuses them every POST here without this
 *  controller having to say so. */
const REQUEST_HANDLERS = ['owner', 'dpo', 'compliance_officer', 'grievance_officer'] as const;

/**
 * The STAFF surface of the shared request substrate.
 *
 * Generic by design: `/requests`, never `/grievances`. The Grievance module
 * (Prompt 28) and the Data Principal Request Tracker add their own endpoints for
 * what is specific to them — complaint categories, rights types, the Personal
 * Data Summary — and both read and move tickets through here. Two ticketing
 * systems is the outcome this controller exists to prevent.
 */
@Controller('requests')
@UseGuards(TenantGuard)
export class RequestController {
  constructor(private readonly requests: RequestService) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('requestType') requestType?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return {
      requests: await this.requests.list({
        status: parseStatusFilter(status),
        requestType: parseRequestTypeFilter(requestType),
        limit: Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 50,
      }),
    };
  }

  /**
   * The FR-GRV-04 work queue. A GET, so the read-only floor lets an Auditor see
   * it — being able to review what the platform asked staff to verify, and what
   * they answered, is most of what an audit of this feature would consist of.
   */
  @Get('identity-verifications')
  async identityTasks(@Query('status') status?: string, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    return {
      tasks: await this.requests.listIdentityTasks(
        status === 'completed' ? 'completed' : 'pending',
        Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 50,
      ),
    };
  }

  @Get('sla-policies')
  async policies() {
    return { policies: await this.requests.listPolicies() };
  }

  @Put('sla-policies')
  // Same class of decision as naming the DPO: it sets what the organisation
  // promises a data principal, so it does not delegate below the DPO.
  @Roles('owner', 'dpo')
  @Audited('request.sla_policy.set')
  @HttpCode(HttpStatus.OK)
  async setPolicy(@Body() body: unknown) {
    return this.requests.setPolicy(parseSetSlaPolicy(body));
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.requests.detail(id);
  }

  /**
   * The identity-verification handoff (FR-GRV-04) — a staff member answering, in
   * their own systems, the question the platform is not allowed to ask. See
   * RequestService.completeIdentityVerification for what this deliberately does
   * not accept.
   */
  @Post(':id/identity-verification')
  @Roles(...REQUEST_HANDLERS)
  @Audited('request.identity_verification.completed')
  @HttpCode(HttpStatus.OK)
  async verifyIdentity(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.completeIdentityVerification(id, parseCompleteIdentityVerification(body));
  }

  @Post(':id/assign')
  @Roles(...REQUEST_HANDLERS)
  @Audited('request.assigned')
  @HttpCode(HttpStatus.OK)
  async assign(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.assign(id, parseAssign(body));
  }

  @Post(':id/status')
  @Roles(...REQUEST_HANDLERS)
  @Audited('request.status.changed')
  @HttpCode(HttpStatus.OK)
  async changeStatus(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.changeStatus(id, parseChangeStatus(body));
  }

  @Post(':id/correspondence')
  @Roles(...REQUEST_HANDLERS)
  @Audited('request.correspondence.added')
  @HttpCode(HttpStatus.CREATED)
  async correspond(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.addCorrespondence(id, parseStaffCorrespondence(body));
  }

  /** Escalate without waiting for the clock (FR-GRV-05). Climbs the same ladder
   *  the SLA deadlines climb — one ladder, two ways of reaching the next rung. */
  @Post(':id/escalate')
  @Roles(...REQUEST_HANDLERS)
  @Audited('request.escalated')
  @HttpCode(HttpStatus.OK)
  async escalate(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseManualEscalation(body);
    return this.requests.escalateNow(id, reason);
  }
}
