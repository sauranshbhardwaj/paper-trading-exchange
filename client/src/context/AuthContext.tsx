import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { LoginInput, RegisterInput, UserDto } from '@pte/shared';
import { api } from '../lib/api.ts';
import { useRealtime } from './RealtimeContext.tsx';

interface AuthValue {
  user: UserDto | null;
  /** True until we know whether the session cookie is valid. */
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { client } = useRealtime();
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(({ user: me }) => setUser(me))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // The WebSocket authenticates with the cookie at connect time, so reconnect whenever it changes.
  const signedIn = useCallback(
    (next: UserDto | null) => {
      setUser(next);
      client.reconnect();
    },
    [client],
  );

  const login = useCallback(
    async (input: LoginInput) => signedIn((await api.login(input)).user),
    [signedIn],
  );
  const register = useCallback(
    async (input: RegisterInput) => signedIn((await api.register(input)).user),
    [signedIn],
  );
  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined); // logging out locally is what matters
    signedIn(null);
  }, [signedIn]);

  const value = useMemo(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
