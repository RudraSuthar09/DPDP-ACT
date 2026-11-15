'use client';

import { useState } from 'react';
import { approveLicense, rejectLicense } from '../../lib/admin-licenses';
import { PlatformAdminApiError } from '../../lib/platform-admin-api';

/**
 * Approve / Reject for ONE pending, unapproved licence. Reject needs a
 * written reason (3+ characters; the backend enforces the same rule and
 * records it in the customer's audit chain). Calls the existing
 * platform-admin endpoints only.
 */
export function LicenseDecisionButtons({
  tenantId,
  licenseId,
  onDone,
}: {
  tenantId: string;
  licenseId: string;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'approve' | 'reject') {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'approve') await approveLicense(tenantId, licenseId);
      else await rejectLicense(tenantId, licenseId, reason.trim());
      setRejecting(false);
      setReason('');
      await onDone();
    } catch (err) {
      setError(err instanceof PlatformAdminApiError ? err.message : `Could not ${kind} this licence.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 110 }}>
      {!rejecting && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            className="primary"
            onClick={() => run('approve')}
            disabled={busy !== null}
            data-testid={`approve-license-${licenseId}`}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
          <button onClick={() => setRejecting(true)} disabled={busy !== null} data-testid={`reject-license-${licenseId}`}>
            Reject
          </button>
        </div>
      )}
      {rejecting && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run('reject');
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required)"
            maxLength={500}
            autoFocus
            data-testid={`reject-reason-${licenseId}`}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="submit"
              className="danger"
              disabled={busy !== null || reason.trim().length < 3}
              data-testid={`reject-confirm-${licenseId}`}
            >
              {busy === 'reject' ? 'Rejecting…' : 'Confirm reject'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejecting(false);
                setReason('');
              }}
              disabled={busy !== null}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <span role="alert" style={{ color: 'var(--color-danger, #b91c1c)', fontSize: '0.8rem' }}>
          {error}
        </span>
      )}
    </div>
  );
}
