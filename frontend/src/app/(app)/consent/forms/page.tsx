'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';

interface FormListItem {
  id: string;
  name: string;
  description: string | null;
  slug: string | null;
  isActive: boolean;
  rowCount: number;
  activeRowCount: number;
  submissionCount: number;
  updatedAt: string;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/**
 * Consent forms (new UX model): a form is a name + a flat list of consent rows,
 * built on one screen. Each form has a single active/inactive switch that
 * decides whether it shows on the tenant's website embed and its hosted link.
 */
export default function ConsentFormsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [forms, setForms] = useState<FormListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ forms: FormListItem[] }>('/consent/forms');
      setForms(res.forms);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load consent forms.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onNew() {
    const name = window.prompt('Name this consent form (e.g. "Website sign-up consent")');
    if (name === null) return;
    if (name.trim().length < 2) {
      setError('A form name needs at least 2 characters.');
      return;
    }
    setError(null);
    try {
      const created = await apiFetch<{ id: string }>('/consent/forms', {
        method: 'POST',
        body: { name: name.trim() },
      });
      router.push(`/consent/forms/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the form.');
    }
  }

  async function onToggleActive(form: FormListItem) {
    setBusyId(form.id);
    setError(null);
    try {
      await apiFetch(`/consent/forms/${form.id}/active`, {
        method: 'PATCH',
        body: { isActive: !form.isActive },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the form status.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div>
      <h1>Consent forms</h1>
      <p className="muted">
        A form is a name and a flat list of consent rows. Toggle a form active to show it on your
        website embed and its share link; toggle it off and it disappears from both, with no code
        change on your side.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
        {canManage && (
          <button className="primary" type="button" onClick={() => void onNew()}>
            + New form
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Rows</th>
              <th>Submissions</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {forms.map((f) => (
              <tr key={f.id}>
                <td>
                  <Link href={`/consent/forms/${f.id}`}>{f.name}</Link>
                </td>
                <td className="muted">
                  {f.activeRowCount}/{f.rowCount} active
                </td>
                <td>{f.submissionCount}</td>
                <td>
                  <span className={`badge ${f.isActive ? 'success' : 'neutral'}`}>
                    {f.isActive ? 'Live' : 'Off'}
                  </span>
                </td>
                <td>
                  {canManage && (
                    <button type="button" disabled={busyId === f.id} onClick={() => void onToggleActive(f)}>
                      {f.isActive ? 'Turn off' : 'Turn on'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {forms.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No consent forms yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
