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
 * Fetches GET /capabilities for the current tenant. Default-safe: while
 * loading (or on error) `capabilities` is null and callers should not hide
 * anything on that basis — nothing in this pass hides UI on this hook, since
 * nothing is gated in the frontend today. It exists so a FUTURE feature gate
 * has one correct place to read from.
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
