'use client';

import { useState } from 'react';
import { apiFetch, ApiError } from '../lib/api';

/**
 * Locked architecture §9/§11: "Install DPDP -> Enter License Key -> Validate
 * License -> Register Installation -> Activate Correct Deployment
 * Capabilities". The server (InstallationService/LicensingService) is the
 * actual authority on whether a key is valid — this component only collects
 * the fields and reports what the backend decided. Used in two places:
 *   - `ActivationPanel`, embedded in Settings (always available, any time).
 *   - `ActivationGate`, a full-screen blocking gate shown by the authenticated
 *     app shell on a fresh installer-provisioned instance with no active
 *     installation yet (see (app)/layout.tsx — opt-in via
 *     NEXT_PUBLIC_REQUIRE_ACTIVATION, never shown for existing hosted tenants).
 */

interface ActivationResult {
  installation: { id: string; status: string };
  capabilities: { plan: string; deploymentType: string };
}

function ActivationForm({ onActivated }: { onActivated: (result: ActivationResult) => void }) {
  const [licenseKey, setLicenseKey] = useState('');
  const [plan, setPlan] = useState<'saas' | 'enterprise'>('saas');
  const [deploymentType, setDeploymentType] = useState<'hosted' | 'client_server'>('hosted');
  const [version, setVersion] = useState('1.0.0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleActivate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiFetch<ActivationResult>('/installations', {
        method: 'POST',
        body: { licenseKey, plan, deploymentType, version },
      });
      onActivated(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not activate this installation.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form onSubmit={handleActivate} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
          License key
          <input
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder="DPDP-..."
            style={{ minWidth: 260 }}
            required
            data-testid="activation-license-key"
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
          Plan
          <select value={plan} onChange={(e) => setPlan(e.target.value as 'saas' | 'enterprise')}>
            <option value="saas">SaaS</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
          Deployment type
          <select value={deploymentType} onChange={(e) => setDeploymentType(e.target.value as 'hosted' | 'client_server')}>
            <option value="hosted">Hosted</option>
            <option value="client_server">Client server</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
          Version
          <input value={version} onChange={(e) => setVersion(e.target.value)} style={{ width: 120 }} required />
        </label>
        <button type="submit" className="primary" disabled={submitting} data-testid="activation-submit">
          {submitting ? 'Activating…' : 'Activate Installation'}
        </button>
      </form>
      {error && (
        <p className="muted" style={{ color: 'var(--color-danger, #b91c1c)', fontSize: '0.85rem' }} data-testid="activation-error">
          {error}
        </p>
      )}
    </>
  );
}

/** The Settings-page embedding: a normal panel, always visible, re-activatable. */
export function ActivationPanel({ onActivated }: { onActivated: () => void }) {
  const [result, setResult] = useState<ActivationResult | null>(null);
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Installation &amp; licensing</h2>
      <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
        Enter a license key to register this deployment. Validated server-side against the license&apos;s
        actual entitlement — the plan/deployment type below must match exactly.
      </p>
      <ActivationForm
        onActivated={(data) => {
          setResult(data);
          onActivated();
        }}
      />
      {result && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Installation {result.installation.id.slice(0, 8)} registered ({result.installation.status}) — capabilities
          now reflect {result.capabilities.plan}/{result.capabilities.deploymentType}.
        </p>
      )}
    </div>
  );
}

/**
 * The full-screen, BLOCKING first-run gate. Shown by (app)/layout.tsx in
 * place of the normal sidebar+content when this is a fresh installer-
 * provisioned instance with no active installation yet. Calls `onActivated`
 * once the backend confirms activation — the layout re-checks and, once a
 * real installation exists, never shows this again.
 */
export function ActivationGate({ onActivated }: { onActivated: () => void }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div className="panel" style={{ maxWidth: 640, width: '100%' }}>
        <h1 style={{ marginTop: 0 }}>Welcome to DPDP</h1>
        <p className="muted">
          This is a fresh local DPDP installation. Enter the license key you received to activate it — the
          license determines whether this deployment runs in SaaS or Enterprise mode.
        </p>
        <ActivationForm onActivated={onActivated} />
      </div>
    </div>
  );
}
