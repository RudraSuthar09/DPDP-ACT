import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ModuleArea, Role, UserStatus } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { UsersRepository, type UserRow } from './users.repository';
import type { AuthenticatedUser } from './provider/identity-provider';

/**
 * Identity operations for an ALREADY authenticated request — profile, the user
 * list, and the lifecycle (FR-IDN-05).
 *
 * These live outside `IdentityProvider` on purpose: they are the platform's own
 * view of its users, not the authentication mechanism. When a Keycloak adapter
 * replaces the provider in Stage 2, this file is largely unaffected.
 *
 * Other modules must call this service rather than reading `users` (R2) — which
 * is why the shapes it returns are plain contracts, not table rows.
 */

export interface TeamMember {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  mfaEnrolled: boolean;
}

@Injectable()
export class IdentityService {
  constructor(
    private readonly db: TenantDatabaseService,
    private readonly users: UsersRepository,
    private readonly tenantContext: TenantContextService,
    // Contributes the domain facts (what changed, to whom, why) that the audit
    // interceptor cannot know. It cannot write an entry — see AuditModule.
    private readonly audit: AuditContextService,
  ) {}

  /** The caller's own profile. Tenant comes from the verified JWT, never the URL. */
  async currentUser(): Promise<AuthenticatedUser> {
    const ctx = this.tenantContext.getOrThrow();
    return this.db.withTenant(async (client) => {
      const row = await this.users.findProfile(client, ctx.userId);
      if (!row) {
        // The token verified but the row is gone from under it. Not a 404: the
        // caller has no business knowing whether the id exists.
        throw new ForbiddenException('Account is not available.');
      }
      return {
        userId: row.id,
        tenantId: row.tenant_id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        organisationName: row.organisation_name,
        mfaEnrolled: row.mfa_enrolled_at !== null,
      };
    });
  }

  /** The five module areas provisioned for this workspace (FR-IDN-01). */
  async workspaceModules(): Promise<ModuleArea[]> {
    return this.db.withTenant((client) => this.users.listWorkspaceModules(client));
  }

  /**
   * The team. Includes suspended and removed users — deliberately: they are
   * still part of the record, and an admin screen that hides removed accounts is
   * one that cannot answer "who had access in March?".
   */
  async listTeam(): Promise<TeamMember[]> {
    return this.db.withTenant(async (client) => {
      const rows = await this.users.listUsers(client);
      return rows.map(toTeamMember);
    });
  }

  /**
   * Suspend or remove a user (FR-IDN-05).
   *
   * There is no delete, here or anywhere: `removed` is a tombstone. The row, its
   * status history, and its audit trail all survive — only the ability to
   * authenticate ends. This is a platform-wide rule and invariant I4, and the
   * database backs it up: dpdp_app holds no DELETE grant on `users`, so a hard
   * delete is not something this code is choosing not to do — it is something it
   * could not do if it tried.
   */
  async changeStatus(
    targetUserId: string,
    status: UserStatus,
    reason: string,
  ): Promise<TeamMember> {
    const ctx = this.tenantContext.getOrThrow();

    if (targetUserId === ctx.userId) {
      // Locking yourself out of the workspace you administer is never the intent.
      throw new BadRequestException('You cannot change your own status.');
    }

    return this.db.withTenant(async (client) => {
      const target = await this.users.findById(client, targetUserId);
      if (!target) {
        // RLS already guarantees we only see our own tenant's users, so a miss
        // here means "not in this tenant" and 404 leaks nothing.
        throw new NotFoundException('User not found.');
      }

      if (target.status === 'removed') {
        throw new BadRequestException(
          'This user has been removed. Removal is permanent — invite them again to restore access.',
        );
      }

      // Refuse to orphan the workspace. An org with no active Owner cannot
      // invite anyone or appoint a new Owner: it is a dead workspace that only a
      // support ticket can revive.
      if (target.role === 'owner' && (await this.users.countActiveOwners(client)) <= 1) {
        throw new BadRequestException(
          'This is the last active Owner. Appoint another Owner before suspending or removing them.',
        );
      }

      const updated = await this.users.setStatus(client, {
        userId: targetUserId,
        status,
        reason,
        actorId: ctx.userId,
      });

      // The before/after the interceptor cannot see. Read from the row we
      // already hold, inside the transaction, so the entry describes the exact
      // state this change moved away from — not whatever it looks like later.
      this.audit.annotate({
        action: status === 'removed' ? 'identity.user.removed' : 'identity.user.suspended',
        targetType: 'user',
        targetId: targetUserId,
        reason,
        beforeState: auditState(target),
        afterState: auditState(updated!),
      });

      return toTeamMember(updated!);
    });
  }

  /**
   * Change a user's role (FR-IDN-03). Owner-only at the API boundary.
   *
   * This is the most security-relevant change anyone can make in the product —
   * it is how someone grants themselves, or a compromised account, the ability
   * to act. So it carries the same requirements as a suspension: a reason, and
   * an entry in the chain naming who did it, to whom, and from what to what.
   */
  async changeRole(targetUserId: string, role: Role, reason: string): Promise<TeamMember> {
    const ctx = this.tenantContext.getOrThrow();

    if (targetUserId === ctx.userId) {
      // Self-promotion (or self-demotion out of the last Owner seat) is never
      // the intent, and it is exactly what a hijacked session would try.
      throw new BadRequestException('You cannot change your own role.');
    }

    return this.db.withTenant(async (client) => {
      const target = await this.users.findById(client, targetUserId);
      if (!target) {
        throw new NotFoundException('User not found.');
      }
      if (target.status === 'removed') {
        throw new BadRequestException('This user has been removed and cannot be given a role.');
      }
      if (target.role === role) {
        throw new BadRequestException(`User is already ${role}.`);
      }
      // Demoting the last Owner orphans the workspace exactly as removing them
      // would: nobody left who can invite or appoint.
      if (target.role === 'owner' && (await this.users.countActiveOwners(client)) <= 1) {
        throw new BadRequestException(
          'This is the last active Owner. Appoint another Owner before changing this role.',
        );
      }

      const updated = await this.users.setRole(client, {
        userId: targetUserId,
        role,
        reason,
        actorId: ctx.userId,
      });

      this.audit.annotate({
        targetType: 'user',
        targetId: targetUserId,
        reason,
        beforeState: auditState(target),
        afterState: auditState(updated!),
      });

      return toTeamMember(updated!);
    });
  }

  /**
   * Restore a suspended user. Only `suspended` → `active`: a removed user stays
   * removed forever and comes back, if at all, as a new invitation — so the
   * tombstone keeps meaning what it says, and the audit trail never has to
   * explain how a removed account started logging in again.
   */
  async reactivate(targetUserId: string, reason: string): Promise<TeamMember> {
    const ctx = this.tenantContext.getOrThrow();

    return this.db.withTenant(async (client) => {
      const target = await this.users.findById(client, targetUserId);
      if (!target) {
        throw new NotFoundException('User not found.');
      }
      if (target.status === 'removed') {
        throw new BadRequestException(
          'Removed users cannot be reactivated. Invite them again to grant access.',
        );
      }
      if (target.status === 'active') {
        throw new BadRequestException('User is already active.');
      }

      const updated = await this.users.setStatus(client, {
        userId: targetUserId,
        status: 'active',
        reason,
        actorId: ctx.userId,
      });

      this.audit.annotate({
        targetType: 'user',
        targetId: targetUserId,
        reason,
        beforeState: auditState(target),
        afterState: auditState(updated!),
      });

      return toTeamMember(updated!);
    });
  }
}

/**
 * The slice of a user row that belongs in an audit entry.
 *
 * Allow-list, never the whole row: a `users` row carries a password hash and an
 * encrypted TOTP secret, and spreading it into before/after would copy both into
 * a table that is append-only and therefore impossible to redact afterwards. The
 * mistake would be permanent by design.
 */
function auditState(row: UserRow): Record<string, unknown> {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    mfaEnrolled: row.mfa_enrolled_at !== null,
  };
}

function toTeamMember(row: UserRow): TeamMember {
  return {
    userId: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    mfaEnrolled: row.mfa_enrolled_at !== null,
  };
}
