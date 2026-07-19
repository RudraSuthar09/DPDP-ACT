import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Audited } from '../audit/audited.decorator';
import { IdentityService } from './identity.service';
import { Roles } from './rbac/roles.decorator';
import {
  parseInviteTeamMember,
  parseReason,
  parseSetDesignation,
  parseSetRole,
  parseSetStatus,
} from './dto';

/**
 * Team and user lifecycle (FR-IDN-03, FR-IDN-05).
 *
 * Note what this controller does NOT have: a DELETE route. Users are suspended
 * or removed, never hard-deleted — platform rule, invariant I4. `removed` is a
 * tombstone the row survives; there is no endpoint that destroys a user, and the
 * dpdp_app role has no DELETE grant to build one with.
 *
 * Every route is tenant-scoped (TenantGuard) and RLS-enforced underneath, so
 * `:id` is only ever resolvable within the caller's own tenant. The global
 * RolesGuard additionally refuses every mutation below to Auditor and Viewer
 * without any annotation here, and the global AuditInterceptor records each one
 * into the hash chain (S5) — the @Audited names below only choose what those
 * entries are CALLED.
 */
@Controller('users')
@UseGuards(TenantGuard)
export class UsersController {
  constructor(private readonly identity: IdentityService) {}

  /** The team, including suspended and removed members — they are part of the record. */
  @Get()
  async list() {
    return this.identity.listTeam();
  }

  /** The five module areas this workspace was provisioned with (FR-IDN-01). */
  @Get('workspace/modules')
  async modules() {
    return { modules: await this.identity.workspaceModules() };
  }

  /**
   * Suspend or remove (FR-IDN-05). Owner and DPO only — this is the Stage 1
   * "basic gating"; Stage 2 makes it granular.
   *
   * The action name is refined per-status by the service (suspended vs removed):
   * this is the fallback for an outcome that reached neither.
   */
  @Post(':id/status')
  @Roles('owner', 'dpo')
  @Audited('identity.user.status_changed')
  @HttpCode(HttpStatus.OK)
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { status, reason } = parseSetStatus(body);
    return this.identity.changeStatus(id, status, reason);
  }

  /**
   * Change a user's role (FR-IDN-03). Owner only: granting privilege is the one
   * action that can manufacture every other permission, so it does not delegate.
   */
  @Post(':id/role')
  @Roles('owner')
  @Audited('identity.user.role_changed')
  @HttpCode(HttpStatus.OK)
  async setRole(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { role, reason } = parseSetRole(body);
    return this.identity.changeRole(id, role, reason);
  }

  /** Restore a SUSPENDED user. Removal is permanent and has no route back. */
  @Post(':id/reactivate')
  @Roles('owner', 'dpo')
  @Audited('identity.user.reactivated')
  @HttpCode(HttpStatus.OK)
  async reactivate(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.identity.reactivate(id, parseReason(body));
  }

  // --- Invitations (FR-IDN-05) ----------------------------------------------

  /**
   * Invite a teammate into THIS tenant (never a new one — see POST
   * /auth/register for that). Owner and DPO only, same gate as suspend/remove:
   * both are ways of shaping who has access. Stage 1 has no outbound email
   * (NotifyModule is a skeleton), so the response hands back the invite link
   * directly for the admin to send — the same pattern registration already
   * uses for `mfaEnrolmentToken`.
   */
  @Post('invite')
  @Roles('owner', 'dpo')
  @Audited('identity.user.invited')
  @HttpCode(HttpStatus.CREATED)
  async invite(@Body() body: unknown) {
    const input = parseInviteTeamMember(body);
    const { invitation, inviteToken } = await this.identity.inviteTeamMember(input);
    return { invitation, inviteToken };
  }

  /** Every invitation this tenant has issued — pending, accepted, revoked. */
  @Get('invitations')
  @Roles('owner', 'dpo')
  async listInvitations() {
    return { invitations: await this.identity.listInvitations() };
  }

  /** Revoke a still-pending invite; a signed token already in someone's inbox
   *  stops working immediately (accept-invite re-checks the row, not the JWT). */
  @Post('invitations/:id/revoke')
  @Roles('owner', 'dpo')
  @Audited('identity.invitation.revoked')
  @HttpCode(HttpStatus.OK)
  async revokeInvitation(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.identity.revokeInvitation(id, parseReason(body));
  }

  // --- Designations (FR-IDN-04) ---------------------------------------------

  /** Which team member is the published DPO / Grievance Officer for this
   *  tenant — readable by anyone authenticated (a GET; the read-only floor
   *  does not apply). The future public portal reads a public projection of this. */
  @Get('designations')
  async listDesignations() {
    return { designations: await this.identity.listDesignations() };
  }

  /** Owner-only: naming who represents the tenant is the same class of decision
   *  as granting a role, so it does not delegate to DPO either. */
  @Post('designations')
  @Roles('owner')
  @Audited('identity.designation.set')
  @HttpCode(HttpStatus.OK)
  async setDesignation(@Body() body: unknown) {
    const { designation, userId, reason } = parseSetDesignation(body);
    return this.identity.setDesignation(designation, userId, reason);
  }
}
