'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, clearToken, getToken, setToken } from './api';

/** Shape of GET /auth/me (AuthenticatedUser in the backend identity module). */
export interface CurrentUser {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: string;
  organisationName: string;
  /** The tenant's public request-portal identifier (FR-GRV-01). */
  portalSlug: string;
  mfaEnrolled: boolean;
  /** Guided-tour state: 'pending' is what auto-launches the tour once. */
  productTourStatus: 'pending' | 'completed' | 'skipped';
}

interface AuthState {
  user: CurrentUser | null;
  /** True until the first /auth/me resolves — guards flicker/redirect races. */
  loading: boolean;
  /** Store a freshly minted access token and load the profile behind it. */
  signIn: (accessToken: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
  /**
   * Reflect a tour outcome locally the moment it happens. The PATCH that
   * persists it is fire-and-forget, so without this the shell would keep the
   * stale 'pending' until the next /auth/me and could re-open the tour on a
   * client-side navigation the user never asked to be interrupted on.
   */
  setProductTourStatus: (status: 'completed' | 'skipped') => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await apiFetch<CurrentUser>('/auth/me'));
    } catch {
      // Token missing/expired/rejected — fail closed to signed-out.
      clearToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (accessToken: string) => {
      setToken(accessToken);
      setLoading(true);
      await refresh();
    },
    [refresh],
  );

  const setProductTourStatus = useCallback((status: 'completed' | 'skipped') => {
    setUser((current) => (current ? { ...current, productTourStatus: status } : current));
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, signIn, signOut, refresh, setProductTourStatus }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>.');
  return ctx;
}
