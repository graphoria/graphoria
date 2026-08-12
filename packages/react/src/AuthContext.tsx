import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ReactNode } from "react";
import type {
  AuthContextType,
  AuthState,
  AuthTransportOptions,
  TokenResponse,
  User,
} from "./types";

import { setAccessToken, setLogoutHandler, setRefreshHandler } from "./tokenStore";
import { GraphQLFetchError, gqlFetch } from "./transport";

// ============================================================================
// Auth Context - in-memory token storage with proactive refresh.
// Auth mutations go over raw fetch — no GraphQL client dependency.
// ============================================================================

const LOGIN_MUTATION = `
  mutation Login($username: String!, $password: String!) {
    auth_login(username: $username, password: $password) {
      access_token
      expires_in
      role
    }
  }
`;

const REFRESH_MUTATION = `
  mutation RefreshToken {
    auth_refresh {
      access_token
      expires_in
      role
    }
  }
`;

const LOGOUT_MUTATION = `
  mutation Logout {
    auth_logout
  }
`;

function createAuthContext<TRole extends string>() {
  return createContext<AuthContextType<TRole> | null>(null);
}

const AuthContext = createAuthContext<string>();

// Module-level cache for the boot refresh. React 18 StrictMode mounts the
// provider twice in dev (mount → cleanup → mount). Without this, the same
// rotating refresh cookie is consumed twice and the second request fails
// with "Token reuse detected". Cleared on logout, and shortly after settling
// so HMR / legit remounts still re-validate.
let bootRefreshPromise: Promise<TokenResponse<string> | null> | null = null;
let bootRefreshClearTimer: ReturnType<typeof setTimeout> | null = null;

function armBootRefreshCacheClear() {
  if (bootRefreshClearTimer) clearTimeout(bootRefreshClearTimer);
  // 1s is far longer than StrictMode's synchronous double-mount window and
  // short enough that a real subsequent mount still re-checks the session.
  bootRefreshClearTimer = setTimeout(() => {
    bootRefreshPromise = null;
    bootRefreshClearTimer = null;
  }, 1000);
}

function resetBootRefreshCache() {
  bootRefreshPromise = null;
  if (bootRefreshClearTimer) {
    clearTimeout(bootRefreshClearTimer);
    bootRefreshClearTimer = null;
  }
}

function createInitialState<TRole extends string>(): AuthState<TRole> {
  return {
    isAuthenticated: false,
    isLoading: true,
    user: null,
    error: null,
  };
}

interface AuthProviderProps<TRole extends string> extends AuthTransportOptions {
  children: ReactNode;
  /** Called when authentication state changes */
  onAuthChange?: (user: User<TRole> | null) => void;
  /** Called after server logout completes — user can clear GraphQL cache here */
  onLogout?: () => void | Promise<void>;
  /** Called after a successful token refresh — user can restart WS / re-auth middleware */
  onTokenRefresh?: (accessToken: string, expiresIn: number) => void;
  /** Rendered while initial session refresh is in flight (default: null) */
  loadingFallback?: ReactNode;
}

export function AuthProvider<TRole extends string = string>({
  children,
  onAuthChange,
  onLogout,
  onTokenRefresh,
  loadingFallback = null,
  httpUri = "/graphql",
  includeCredentials = true,
}: AuthProviderProps<TRole>) {
  const [state, setState] = useState<AuthState<TRole>>(createInitialState<TRole>());

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAuthChangeRef = useRef(onAuthChange);
  const onLogoutRef = useRef(onLogout);
  const onTokenRefreshRef = useRef(onTokenRefresh);

  useEffect(() => {
    onAuthChangeRef.current = onAuthChange;
    onLogoutRef.current = onLogout;
    onTokenRefreshRef.current = onTokenRefresh;
  }, [onAuthChange, onLogout, onTokenRefresh]);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const applyTokens = useCallback((tokens: TokenResponse<TRole>) => {
    setAccessToken(tokens.access_token);
    onTokenRefreshRef.current?.(tokens.access_token, tokens.expires_in);
  }, []);

  const setAuthFromToken = useCallback(
    (tokens: TokenResponse<TRole>) => {
      applyTokens(tokens);

      const user: User<TRole> = { role: tokens.role };
      setState({
        isAuthenticated: true,
        isLoading: false,
        user,
        error: null,
      });

      onAuthChangeRef.current?.(user);
    },
    [applyTokens],
  );

  const callRefresh = useCallback(async (): Promise<TokenResponse<TRole> | null> => {
    const data = await gqlFetch<{ auth_refresh: TokenResponse<TRole> | null }>(
      httpUri,
      REFRESH_MUTATION,
      undefined,
      { credentials: includeCredentials },
    );
    return data.auth_refresh ?? null;
  }, [httpUri, includeCredentials]);

  const scheduleRefresh = useCallback(
    (expiresIn: number) => {
      clearRefreshTimer();
      // Refresh 30s before expiry (minimum 10s)
      const refreshInMs = Math.max((expiresIn - 30) * 1000, 10000);

      refreshTimerRef.current = setTimeout(() => {
        callRefresh()
          .then((tokens) => {
            if (tokens) {
              applyTokens(tokens);
              setState((s) => ({ ...s, user: { role: tokens.role } }));
              scheduleRefresh(tokens.expires_in);
            }
          })
          .catch((err) => {
            console.error("[Auth] Refresh failed:", err);
          });
      }, refreshInMs);
    },
    [clearRefreshTimer, callRefresh, applyTokens],
  );

  const refreshToken = useCallback(async (): Promise<boolean> => {
    try {
      const tokens = await callRefresh();
      if (tokens) {
        applyTokens(tokens);
        scheduleRefresh(tokens.expires_in);
        setState((s) => ({ ...s, user: { role: tokens.role } }));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [callRefresh, applyTokens, scheduleRefresh]);

  const logout = useCallback(async (): Promise<void> => {
    clearRefreshTimer();
    resetBootRefreshCache();
    setAccessToken(null);

    setState({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      error: null,
    });

    try {
      await gqlFetch<{ auth_logout: boolean }>(httpUri, LOGOUT_MUTATION, undefined, {
        credentials: includeCredentials,
      });
    } catch (error) {
      console.error("Logout request failed:", error);
    }

    try {
      await onLogoutRef.current?.();
    } catch (error) {
      console.error("onLogout callback failed:", error);
    }

    onAuthChangeRef.current?.(null);
  }, [clearRefreshTimer, httpUri, includeCredentials]);

  // Wire the module-level token store so any GraphQL client can drive
  // the refresh/logout loop via ensureFreshToken().
  useEffect(() => {
    setRefreshHandler(refreshToken);
    setLogoutHandler(logout);
    return () => {
      setRefreshHandler(null);
      setLogoutHandler(null);
    };
  }, [refreshToken, logout]);

  // Boot: try refreshing the session using the HTTP-only cookie.
  useEffect(() => {
    let mounted = true;

    const tryRefresh = async () => {
      try {
        if (!bootRefreshPromise) {
          bootRefreshPromise = callRefresh() as Promise<TokenResponse<string> | null>;
          bootRefreshPromise.finally(armBootRefreshCacheClear).catch(() => {});
        }
        const tokens = (await bootRefreshPromise) as TokenResponse<TRole> | null;
        if (!mounted) return;

        if (tokens) {
          setAuthFromToken(tokens);
          scheduleRefresh(tokens.expires_in);
        } else {
          setState((s) => ({ ...s, isLoading: false }));
        }
      } catch {
        if (!mounted) return;
        setState((s) => ({ ...s, isLoading: false }));
      }
    };
    void tryRefresh();

    return () => {
      mounted = false;
      clearRefreshTimer();
    };
  }, [callRefresh, setAuthFromToken, scheduleRefresh, clearRefreshTimer]);

  const login = useCallback(
    async (username: string, password: string): Promise<User<TRole> | null> => {
      setState((s) => ({ ...s, isLoading: true, error: null }));

      try {
        const data = await gqlFetch<{ auth_login: TokenResponse<TRole> | null }>(
          httpUri,
          LOGIN_MUTATION,
          { username, password },
          { credentials: includeCredentials },
        );

        if (data.auth_login) {
          const tokens = data.auth_login;
          // Invalidate any cached "no session" boot result so a later
          // provider remount re-checks against the now-valid refresh cookie.
          resetBootRefreshCache();
          setAuthFromToken(tokens);
          scheduleRefresh(tokens.expires_in);
          return { role: tokens.role };
        }

        setState((s) => ({
          ...s,
          isLoading: false,
          error: "Invalid credentials",
        }));
        return null;
      } catch (error: unknown) {
        const message =
          error instanceof GraphQLFetchError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Login failed";

        setState((s) => ({ ...s, isLoading: false, error: message }));
        return null;
      }
    },
    [httpUri, includeCredentials, setAuthFromToken, scheduleRefresh],
  );

  const hasRole = useCallback((role: TRole) => state.user?.role === role, [state.user]);

  const hasAnyRole = useCallback(
    (roles: TRole[]): boolean => {
      return state.user?.role ? roles.includes(state.user.role) : false;
    },
    [state.user],
  );

  const value = useMemo<AuthContextType<TRole>>(
    () => ({
      ...state,
      login,
      logout,
      hasRole,
      hasAnyRole,
      refreshToken,
    }),
    [state, login, logout, hasRole, hasAnyRole, refreshToken],
  );

  if (state.isLoading) return <>{loadingFallback}</>;

  return (
    // AuthContext is type-erased to AuthContextType<string> at the React
    // boundary; useAuth<TRole>() casts back. Both casts need the unknown
    // intermediate because TRole's contravariant positions defeat narrowing.
    <AuthContext.Provider value={value as unknown as AuthContextType<string>}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth<TRole extends string = string>(): AuthContextType<TRole> {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context as unknown as AuthContextType<TRole>;
}

/** @internal Test-only: flushes the StrictMode boot-refresh cache. Not re-exported from index.ts. */
export function __resetBootRefreshCacheForTest(): void {
  resetBootRefreshCache();
}
