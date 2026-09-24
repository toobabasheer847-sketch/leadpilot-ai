import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi, readToken, writeToken } from '../api/endpoints';
import { ApiError } from '../api/client';
import type { AuthUser } from '../types/api';

type Status = 'loading' | 'authenticated' | 'anonymous';

const AuthContext = createContext<{
  status: Status;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string; organizationName: string }) => Promise<void>;
  logout: () => void;
} | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(readToken() ? 'loading' : 'anonymous');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    if (!readToken()) return;
    let active = true;
    authApi.me().then((next) => {
      if (!active) return;
      setUser(next);
      setStatus('authenticated');
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) writeToken(null);
      setUser(null);
      setStatus('anonymous');
    });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(() => ({
    status,
    user,
    login: async (email: string, password: string) => {
      const session = await authApi.login(email, password);
      writeToken(session.accessToken);
      setUser(session.user);
      setStatus('authenticated');
    },
    register: async (input: { name: string; email: string; password: string; organizationName: string }) => {
      const session = await authApi.register(input);
      writeToken(session.accessToken);
      setUser(session.user);
      setStatus('authenticated');
    },
    logout: () => {
      writeToken(null);
      setUser(null);
      setStatus('anonymous');
    },
  }), [status, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is required');
  return value;
}
