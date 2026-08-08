'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError, API_URL } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';

/**
 * The ONE integration surface per tenant (new UX model). A single embed snippet
 * — reusing the existing publishable API key — that the client pastes once. The
 * widget calls GET /consent/public/active-forms at render time and shows
 * whichever forms are currently active, so toggling a form/row on the platform
 * changes the live site with no code change. Per-form hosted links (a distinct
 * use case — one ask to one person) are listed separately below.
 */
interface ApiKeySummary {
  id: string;
  label: string;
  keyPrefix: string;
  revokedAt: string | null;
}
interface WidgetManifest {
  version: string;
  file: string;
  integrity: string;
}
interface FormListItem {
  id: string;
  name: string;
  slug: string | null;
  isActive: boolean;
}

const WRITE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

export default function IntegrationPage() {
  const { user } = useAuth();
  const canWrite = !!user && WRITE_ROLES.has(user.role);

  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [manifest, setManifest] = useState<WidgetManifest | null>(null);
  const [forms, setForms] = useState<FormListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [keysRes, formsRes, manifestRes] = await Promise.all([
        apiFetch<{ keys: ApiKeySummary[] }>('/consent/api-keys'),
        apiFetch<{ forms: FormListItem[] }>('/consent/forms'),
        fetch(`${API_URL}/consent-sdk/v1/form-widget-manifest.json`).then((r) => (r.ok ? (r.json() as Promise<WidgetManifest>) : null)),
      ]);
      setKeys(keysRes.keys);
      setForms(formsRes.forms);
      setManifest(manifestRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load integration settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch<ApiKeySummary & { key: string }>('/consent/api-keys', {
        method: 'POST',
        body: { label: labelInput.trim() || 'Website integration' },
      });
      setNewKey(res.key);
      setLabelInput('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the API key.');
    } finally {
      setCreating(false);
    }
  }

  const activeKey = keys.find((k) => !k.revokedAt);
  const snippet =
    manifest && activeKey
      ? `<div id="dpdp-consent-forms"></div>\n` +
        `<script src="${API_URL}/consent-sdk/v1/${manifest.file}"\n` +
        `        integrity="${manifest.integrity}"\n` +
        `        crossorigin="anonymous"></script>\n` +
        `<script>\n` +
        `  new DPDPConsentForms({\n` +
        `    apiKey: "${newKey ?? activeKey.keyPrefix + '…'}",\n` +
        `    container: "#dpdp-consent-forms",\n` +
        `    customerId: /* your logged-in visitor's own id */ "CUSTOMER_ID",\n` +
        `  }).mount();\n` +
        `</script>`
      : null;

  const liveForms = forms.filter((f) => f.isActive);

  return (
    <div>
      <h1>Integration</h1>
      <p className="muted">
        One snippet for your whole website. Paste it once; it always shows whichever consent forms
        are currently live. Turn a form on or off under <Link href="/consent/forms">Forms</Link> and
        your site updates itself — no code change.
      </p>

      {error && <div className="error">{error}</div>}

      {canWrite && (
        <form className="panel" onSubmit={onCreate} style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Publishable key</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Safe to embed in public page JavaScript. It can only read your active forms and record
            consent — nothing else. Shown once, here.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <label htmlFor="key-label">Label</label>
              <input id="key-label" value={labelInput} onChange={(e) => setLabelInput(e.target.value)} placeholder="e.g. Marketing site" disabled={creating} />
            </div>
            <button className="primary" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create key'}</button>
          </div>
          {newKey && (
            <div className="mono panel" style={{ marginTop: 12, wordBreak: 'break-all', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>{newKey}</span>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(newKey); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          )}
        </form>
      )}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Website embed snippet (site-wide)</h2>
        {!activeKey && !loading && <div className="muted">Create a publishable key above to generate your snippet.</div>}
        {!manifest && activeKey && <div className="muted">The forms widget isn&apos;t currently being served by the API.</div>}
        {snippet && (
          <>
            <pre className="mono panel" style={{ overflowX: 'auto', whiteSpace: 'pre' }}>{snippet}</pre>
            {!newKey && (
              <p className="muted" style={{ fontSize: '0.8rem' }}>
                Replace the key prefix with a full key (shown once when created). {liveForms.length} form
                {liveForms.length === 1 ? '' : 's'} currently live.
              </p>
            )}
          </>
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Per-form share links</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          A distinct use case from the embed: a direct link to one specific form, for sending a
          single consent ask to a single person over WhatsApp, email or SMS. Manage each on its
          form&apos;s page.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Form</th><th>Status</th><th>Hosted link</th></tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id}>
                  <td><Link href={`/consent/forms/${f.id}`}>{f.name}</Link></td>
                  <td><span className={`badge ${f.isActive ? 'success' : 'neutral'}`}>{f.isActive ? 'Live' : 'Off'}</span></td>
                  <td className="mono" style={{ fontSize: '0.8rem' }}>
                    {f.slug ? `/forms/${f.slug}` : '—'}
                  </td>
                </tr>
              ))}
              {forms.length === 0 && (
                <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 20 }}>No forms yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
