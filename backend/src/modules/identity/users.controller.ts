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
import { parseReason, parseSetRole, parseSetStatus } from './dto';

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
}
