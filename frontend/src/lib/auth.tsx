'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError, clearToken, getToken, setToken } from './api';

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
  /** Descriptive org metadata (visibility only). */
  plan: string;
  deploymentType: string;
}

interface AuthState {
  user: CurrentUser | null;
  /** True until the first /auth/me resolves — guards flicker/redirect races. */
  loading: boolean;
  /**
   * We have a token and a previously-known user, but the last attempt to reach
   * the API failed to CONNECT (not a rejection of the token). The session is
   * kept exactly as it was — this is not a logged-out state — while a
   * background retry keeps trying to reach the server again.
   */
  connectionError: boolean;
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
  const [connectionError, setConnectionError] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setConnectionError(false);
      setLoading(false);
      return;
    }
    try {
      const me = await apiFetch<CurrentUser>('/auth/me');
      setUser(me);
      setConnectionError(false);
    } catch (err) {
      // Status 0 means `fetch` itself failed — the API is unreachable (down,
      // restarting, a network blip). That says NOTHING about whether the
      // token is valid, so the session must survive it: keep the token and
      // whatever user we already had, flag the connection as degraded, and
      // keep retrying in the background. Only a response the server actually
      // sent back (401/403/etc — a real rejection of the token) means the
      // session itself is invalid and should be cleared.
      if (err instanceof ApiError && err.status === 0) {
        setConnectionError(true);
        if (retryTimer.current === null) {
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            void refresh();
          }, 5000);
        }
      } else {
        clearToken();
        setUser(null);
        setConnectionError(false);
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    };
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
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    clearToken();
    setUser(null);
    setConnectionError(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, connectionError, signIn, signOut, refresh, setProductTourStatus }}
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
