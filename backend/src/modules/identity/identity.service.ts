import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ModuleArea, Role, UserStatus } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { TokenService } from './token.service';
import type { Designation } from './dto';
import {
  UsersRepository,
  type DesignationRow,
  type InvitationRow,
  type UserRow,
} from './users.repository';
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

export interface Invitation {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: InvitationRow['status'];
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

export interface TeamDesignation {
  designation: Designation;
  userId: string;
  setAt: string;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class IdentityService {
  constructor(
    private readonly db: TenantDatabaseService,
    private readonly users: UsersRepository,
    private readonly tenantContext: TenantContextService,
    private readonly tokens: TokenService,
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
        portalSlug: row.portal_slug,
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

  // --- Invitations (FR-IDN-05) — joining an EXISTING tenant ----------------

  /**
   * Invite a teammate into the CALLER'S tenant. Returns the invite token
   * un-hashed and un-stored — there is nothing to look it up by later, only the
   * invitations row (which the token names by id) and the accept endpoint's
   * re-check of that row's status. Stage 1 has no outbound email (NotifyModule
   * is a skeleton), so the caller is handed the token/link directly, exactly as
   * registration hands back `mfaEnrolmentToken` instead of emailing it.
   */
  async inviteTeamMember(input: {
    email: string;
    fullName: string;
    role: Role;
    reason: string;
  }): Promise<{ invitation: Invitation; inviteToken: string }> {
    const ctx = this.tenantContext.getOrThrow();

    // The login peephole answers exactly this question — "does this email
    // belong to anyone, in any tenant?" — which is otherwise unaskable under
    // RLS. Checking now, not only at accept time, surfaces a taken email
    // immediately instead of days later when the invitee tries to sign up.
    const existing = await this.db.resolveLogin(input.email);
    if (existing) {
      throw new ConflictException('An account already exists for that email address.');
    }

    try {
      const invitation = await this.db.withTenant((client) =>
        this.users.insertInvitation(client, {
          tenantId: ctx.tenantId,
          email: input.email,
          fullName: input.fullName,
          role: input.role,
          invitedBy: ctx.userId,
          reason: input.reason,
          expiresAt: this.tokens.inviteExpiry(),
        }),
      );

      this.audit.annotate({
        targetType: 'invitation',
        targetId: invitation.id,
        reason: input.reason,
        afterState: { email: invitation.email, role: invitation.role, status: invitation.status },
      });

      const inviteToken = this.tokens.mintInviteToken({
        invitationId: invitation.id,
        tenantId: ctx.tenantId,
        email: invitation.email,
        role: invitation.role,
      });

      return { invitation: toInvitation(invitation), inviteToken };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('An invitation is already pending for that email address.');
      }
      throw err;
    }
  }

  /** Every invitation this tenant has issued — pending, accepted, and revoked,
   *  for the same "the record survives" reasoning as never-hard-delete on users. */
  async listInvitations(): Promise<Invitation[]> {
    return this.db.withTenant(async (client) => {
      const rows = await this.users.listInvitations(client);
      return rows.map(toInvitation);
    });
  }

  /** Revoke a still-pending invite. A signed token in someone's inbox stops
   *  working the moment this runs — accept-invite re-checks the row, not just
   *  the token's signature. */
  async revokeInvitation(invitationId: string, reason: string): Promise<Invitation> {
    const ctx = this.tenantContext.getOrThrow();
    return this.db.withTenant(async (client) => {
      const invitation = await this.users.findInvitationById(client, invitationId);
      if (!invitation) {
        throw new NotFoundException('Invitation not found.');
      }
      if (invitation.status !== 'pending') {
        throw new BadRequestException(`This invitation is already ${invitation.status}.`);
      }

      const revoked = await this.users.revokeInvitation(client, invitationId, ctx.userId);

      this.audit.annotate({
        targetType: 'invitation',
        targetId: invitationId,
        reason,
        beforeState: { status: 'pending' },
        afterState: { status: 'revoked' },
      });

      return toInvitation(revoked!);
    });
  }

  // --- Designations (FR-IDN-04) — the published DPO / Grievance Officer ----

  /**
   * Mark which team member holds a designation — the fact the (future) public
   * portal reads. Distinct from `role`: this does not change what the person
   * can DO, only who is named as the tenant's DPO / Grievance Officer contact.
   */
  async setDesignation(
    designation: Designation,
    targetUserId: string,
    reason: string,
  ): Promise<TeamDesignation> {
    const ctx = this.tenantContext.getOrThrow();
    return this.db.withTenant(async (client) => {
      const target = await this.users.findById(client, targetUserId);
      if (!target) {
        throw new NotFoundException('User not found.');
      }
      if (target.status !== 'active') {
        throw new BadRequestException('Only an active team member can be designated.');
      }

      const before = (await this.users.listDesignations(client)).find(
        (d) => d.designation === designation,
      );

      const row = await this.users.upsertDesignation(client, {
        designation,
        userId: targetUserId,
        reason,
        setBy: ctx.userId,
      });

      this.audit.annotate({
        targetType: 'org_designation',
        targetId: `${designation}`,
        reason,
        beforeState: before ? { userId: before.user_id } : null,
        afterState: { userId: row.user_id },
      });

      return { designation: row.designation, userId: row.user_id, setAt: row.set_at.toISOString() };
    });
  }

  /** The tenant's current designations — at most one row per kind (DPO, Grievance
   *  Officer, escalation contact). */
  async listDesignations(): Promise<TeamDesignation[]> {
    return this.db.withTenant(async (client) => {
      const rows = await this.users.listDesignations(client);
      return rows.map((r) => ({
        designation: r.designation,
        userId: r.user_id,
        setAt: r.set_at.toISOString(),
      }));
    });
  }

  /**
   * Resolve an escalation ladder to the people who currently hold each rung
   * (FR-GRV-05), with the contact address each one would be alerted at.
   *
   * This exists so the request substrate never reads `org_designations` or
   * `users` itself (R2). It asks identity a question in identity's own terms —
   * "who is your DPO, and how do I reach them?" — and gets back a contract, not
   * table rows.
   *
   * An unheld or non-active rung resolves to `null` rather than throwing. A
   * tenant that has not named a DPO yet must still be able to take grievances,
   * and the honest outcome is an escalation recorded as undeliverable — which
   * someone can see and fix — not a request that could not be filed, or a rung
   * silently skipped as though it had been handled.
   */
  async resolveEscalationLadder(
    rungs: readonly Designation[],
  ): Promise<Map<Designation, { userId: string; email: string; fullName: string } | null>> {
    return this.db.withTenant(async (client) => {
      const designations = await this.users.listDesignations(client);
      const users = await this.users.listUsers(client);
      const byId = new Map(users.map((u) => [u.id, u]));

      const resolved = new Map<
        Designation,
        { userId: string; email: string; fullName: string } | null
      >();
      for (const rung of rungs) {
        const holder = designations.find((d) => d.designation === rung);
        const user = holder ? byId.get(holder.user_id) : undefined;
        resolved.set(
          rung,
          user && user.status === 'active'
            ? { userId: user.id, email: user.email, fullName: user.full_name }
            : null,
        );
      }
      return resolved;
    });
  }
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at ? row.accepted_at.toISOString() : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
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
