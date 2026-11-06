'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from './api';

/**
 * The frontend's ONE door to the centralized capability model (locked
 * architecture §10). Nowhere else in the frontend should branch on
 * `plan`/`deploymentType` directly — a future feature gate reads
 * `features.<key>` from here. This is UX only: the backend (CapabilityGuard/
 * assertCapability) is the actual security boundary, never this hook.
 */

export type FeatureKey = 'saas' | 'enterprise' | 'enterpriseGateway' | 'databaseConnectors' | 'localConnectors';

export interface Capabilities {
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  features: Record<FeatureKey, boolean>;
}

interface CapabilitiesState {
  capabilities: Capabilities | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetches GET /capabilities for the current tenant. `capabilities` is null
 * while loading (or on error) — callers gating Enterprise-only UI on a
 * feature flag should default to HIDDEN in that state (not shown), so a
 * SaaS/hosted tenant never sees even a one-frame flash of something their
 * plan doesn't include. See the Data Sources and Storage pages'
 * `enterpriseGateway`-gated sections for the pattern. This is UX only — the
 * backend (CapabilityGuard/assertCapability) is the real enforcement, so
 * hiding something here is never itself the security boundary.
 */
export function useCapabilities(): CapabilitiesState {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<Capabilities>('/capabilities')
      .then((data) => {
        if (!cancelled) {
          setCapabilities(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load capabilities.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { capabilities, loading, error, refresh: () => setNonce((n) => n + 1) };
}
