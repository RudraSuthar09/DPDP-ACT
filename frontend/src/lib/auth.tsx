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
  mfaEnrolled: boolean;
}

interface AuthState {
  user: CurrentUser | null;
  /** True until the first /auth/me resolves — guards flicker/redirect races. */
  loading: boolean;
  /** Store a freshly minted access token and load the profile behind it. */
  signIn: (accessToken: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
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

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>.');
  return ctx;
}
