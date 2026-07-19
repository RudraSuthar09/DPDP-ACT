'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLES, type Role } from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

/**
 * Org Admin surface (FR-IDN-04/05): team list, invite flow, role assignment,
 * suspend/remove, and DPO/Grievance Officer designation — all against the real
 * identity endpoints built in Prompt 4/5 plus the invite/designation routes
 * added alongside this screen. Tenant-scoped throughout: every call runs under
 * the caller's own JWT, so RLS confines everything to one org — there is no
 * cross-tenant view here, by construction, not by a client-side filter.
 */
interface TeamMember {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  status: 'active' | 'suspended' | 'removed';
  mfaEnrolled: boolean;
}
interface Invitation {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}
interface Designation {
  designation: 'dpo' | 'grievance_officer';
  userId: string;
  setAt: string;
}

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  dpo: 'DPO',
  compliance_officer: 'Compliance Officer',
  grievance_officer: 'Grievance Officer',
  auditor: 'Auditor',
  viewer: 'Viewer',
};

export default function TeamPage() {
  const { user } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'dpo';
  const isOwner = user?.role === 'owner';

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [designations, setDesignations] = useState<Designation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showInvite, setShowInvite] = useState(false);
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [teamRes, designationsRes] = await Promise.all([
        apiFetch<TeamMember[]>('/users'),
        apiFetch<{ designations: Designation[] }>('/users/designations'),
      ]);
      setMembers(teamRes);
      setDesignations(designationsRes.designations);

      // Only Owner/DPO can see invitations (matches the backend's @Roles gate) —
      // request it separately so a Viewer/Auditor still sees the team list.
      if (canManage) {
        const invRes = await apiFetch<{ invitations: Invitation[] }>('/users/invitations');
        setInvitations(invRes.invitations);
      } else {
        setInvitations([]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the team.');
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeMembers = useMemo(() => members.filter((m) => m.status === 'active'), [members]);
  const pendingInvitations = useMemo(
    () => invitations.filter((i) => i.status === 'pending'),
    [invitations],
  );

  return (
    <div>
      <h1>Team</h1>
      <p className="muted">
        Your organisation&apos;s people, roles, and lifecycle (FR-IDN-03/05) — never hard-deleted.
      </p>

      {error && <div className="error">{error}</div>}

      <Designations
        designations={designations}
        members={activeMembers}
        canEdit={isOwner}
        onChanged={load}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 28 }}>
        <h2 style={{ margin: 0 }}>Members</h2>
        {canManage && (
          <button className="primary" onClick={() => setShowInvite((v) => !v)}>
            {showInvite ? 'Cancel' : 'Invite teammate'}
          </button>
        )}
      </div>

      {showInvite && (
        <InviteForm
          onInvited={(link) => {
            setLastInviteLink(link);
            setShowInvite(false);
            void load();
          }}
        />
      )}

      {lastInviteLink && (
        <div className="notice" style={{ marginTop: 12 }}>
          Invitation created. There is no email system yet (Stage 1) — copy this link and send it to
          them yourself:
          <div className="mono panel" style={{ marginTop: 8, wordBreak: 'break-all' }}>
            {lastInviteLink}
          </div>
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>MFA</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <MemberRow key={m.userId} member={m} self={m.userId === user?.userId} canManage={canManage} isOwner={isOwner} onChanged={load} />
            ))}
            {members.length === 0 && !loading && (
              <tr>
                <td colSpan={canManage ? 6 : 5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No team members.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canManage && (
        <>
          <h2 style={{ marginTop: 28 }}>Pending invitations</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingInvitations.map((i) => (
                  <InvitationRow key={i.id} invitation={i} onChanged={load} />
                ))}
                {pendingInvitations.length === 0 && !loading && (
                  <tr>
                    <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                      No pending invitations.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function promptReason(action: string): string | null {
  const reason = window.prompt(`Why are you ${action}? (required, kept as evidence)`);
  if (reason === null) return null; // cancelled
  return reason.trim();
}

function MemberRow({
  member,
  self,
  canManage,
  isOwner,
  onChanged,
}: {
  member: TeamMember;
  self: boolean;
  canManage: boolean;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onRoleChange(role: Role) {
    if (role === member.role) return;
    const reason = promptReason(`changing this person's role to ${ROLE_LABEL[role]}`);
    if (reason === null) return;
    await run(() =>
      apiFetch(`/users/${member.userId}/role`, { method: 'POST', body: { role, reason } }),
    );
  }

  async function onStatus(status: 'suspended' | 'removed') {
    const verb = status === 'removed' ? 'removing' : 'suspending';
    const reason = promptReason(`${verb} this person`);
    if (reason === null) return;
    if (status === 'removed' && !window.confirm('Removal is permanent and cannot be undone. Continue?')) {
      return;
    }
    await run(() =>
      apiFetch(`/users/${member.userId}/status`, { method: 'POST', body: { status, reason } }),
    );
  }

  async function onReactivate() {
    const reason = promptReason('reactivating this person');
    if (reason === null) return;
    await run(() => apiFetch(`/users/${member.userId}/reactivate`, { method: 'POST', body: { reason } }));
  }

  return (
    <tr>
      <td>
        {member.fullName} {self && <span className="tag">you</span>}
      </td>
      <td>{member.email}</td>
      <td>
        {isOwner && !self && member.status === 'active' ? (
          <select value={member.role} disabled={busy} onChange={(e) => void onRoleChange(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        ) : (
          <span className="mono">{ROLE_LABEL[member.role]}</span>
        )}
      </td>
      <td>
        <span className={`badge ${member.status === 'active' ? 'success' : 'denied'}`}>{member.status}</span>
      </td>
      <td>{member.mfaEnrolled ? 'Enrolled' : <span className="muted">Not enrolled</span>}</td>
      {canManage && (
        <td>
          {!self && member.status === 'active' && (
            <>
              <button disabled={busy} onClick={() => void onStatus('suspended')}>
                Suspend
              </button>{' '}
              <button disabled={busy} onClick={() => void onStatus('removed')}>
                Remove
              </button>
            </>
          )}
          {!self && member.status === 'suspended' && (
            <>
              <button disabled={busy} onClick={() => void onReactivate()}>
                Reactivate
              </button>{' '}
              <button disabled={busy} onClick={() => void onStatus('removed')}>
                Remove
              </button>
            </>
          )}
          {member.status === 'removed' && <span className="muted">Tombstoned — permanent</span>}
          {self && <span className="muted">—</span>}
          {error && <div className="error">{error}</div>}
        </td>
      )}
    </tr>
  );
}

function InvitationRow({ invitation, onChanged }: { invitation: Invitation; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRevoke() {
    const reason = promptReason('revoking this invitation');
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/users/invitations/${invitation.id}/revoke`, { method: 'POST', body: { reason } });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{invitation.email}</td>
      <td>{invitation.fullName}</td>
      <td className="mono">{ROLE_LABEL[invitation.role]}</td>
      <td>{new Date(invitation.expiresAt).toLocaleDateString()}</td>
      <td>
        <button disabled={busy} onClick={() => void onRevoke()}>
          Revoke
        </button>
        {error && <div className="error">{error}</div>}
      </td>
    </tr>
  );
}

function InviteForm({ onInvited }: { onInvited: (link: string) => void }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ inviteToken: string }>('/users/invite', {
        method: 'POST',
        body: { email, fullName, role, reason },
      });
      const link = `${window.location.origin}/accept-invite?token=${encodeURIComponent(res.inviteToken)}`;
      onInvited(link);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the invitation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="panel" style={{ marginTop: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label>Full name</label>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </div>
        <div>
          <label>Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Reason (kept as evidence)</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. New compliance hire" required />
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ marginTop: 12 }}>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Create invitation'}
        </button>
      </div>
    </form>
  );
}

function Designations({
  designations,
  members,
  canEdit,
  onChanged,
}: {
  designations: Designation[];
  members: TeamMember[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h2 style={{ marginTop: 0 }}>Published designations</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Who is named as this org&apos;s DPO and Grievance Officer (FR-IDN-04). Shown on the public portal
        once it ships.
      </p>
      <DesignationRow
        label="Data Protection Officer"
        kind="dpo"
        current={designations.find((d) => d.designation === 'dpo')}
        members={members}
        canEdit={canEdit}
        onChanged={onChanged}
      />
      <DesignationRow
        label="Grievance Officer"
        kind="grievance_officer"
        current={designations.find((d) => d.designation === 'grievance_officer')}
        members={members}
        canEdit={canEdit}
        onChanged={onChanged}
      />
    </div>
  );
}

function DesignationRow({
  label,
  kind,
  current,
  members,
  canEdit,
  onChanged,
}: {
  label: string;
  kind: 'dpo' | 'grievance_officer';
  current: Designation | undefined;
  members: TeamMember[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentMember = members.find((m) => m.userId === current?.userId);

  async function onAssign(userId: string) {
    if (!userId || userId === current?.userId) return;
    const reason = promptReason(`designating this person as ${label}`);
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/users/designations', {
        method: 'POST',
        body: { designation: kind, userId, reason },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set the designation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
      <div style={{ minWidth: 200 }}>{label}</div>
      {canEdit ? (
        <select value={current?.userId ?? ''} disabled={busy} onChange={(e) => void onAssign(e.target.value)}>
          <option value="">— none —</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.fullName} ({m.email})
            </option>
          ))}
        </select>
      ) : (
        <span>{currentMember ? `${currentMember.fullName} (${currentMember.email})` : <span className="muted">Not set</span>}</span>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
