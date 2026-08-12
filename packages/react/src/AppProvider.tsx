import { createContext, useContext, useMemo } from "react";

import type { ReactNode } from "react";
import type { AuthTransportOptions, RouteConfig } from "./types";

import { AuthProvider, useAuth } from "./AuthContext";

// ============================================================================
// App Provider - composes AuthProvider + RouteConfigContext.
// Bring your own GraphQL client (Apollo, urql, relay, raw fetch — anything).
// ============================================================================

export interface RouteConfigContextType<TRole extends string = string> {
  config: RouteConfig<TRole>;
  isProtectedRoute: (path: string) => boolean;
  getRequiredRoles: (path: string) => TRole[] | null;
  canRoleAccess: (path: string, role: TRole | null) => boolean;
  getRedirectPath: (role: TRole, returnTo?: string) => string;
}

const RouteConfigContext = createContext<RouteConfigContextType<string> | null>(null);

export function useRouteConfig<TRole extends string = string>(): RouteConfigContextType<TRole> {
  const context = useContext(RouteConfigContext);
  if (!context) {
    throw new Error("useRouteConfig must be used within an AppProvider");
  }
  return context as RouteConfigContextType<TRole>;
}

interface AppProviderProps<TRole extends string = string> extends AuthTransportOptions {
  children: ReactNode;
  /** Route configuration with permissions and default routes */
  routeConfig: RouteConfig<TRole>;
  /** Called when authentication state changes */
  onAuthChange?: (user: { role: TRole } | null) => void;
  /** Called after server logout completes — clear your GraphQL cache here */
  onLogout?: () => void | Promise<void>;
  /** Called after a successful token refresh — restart your WS / re-auth your middleware */
  onTokenRefresh?: (accessToken: string, expiresIn: number) => void;
  /** Rendered while initial session refresh is in flight */
  loadingFallback?: ReactNode;
}

const configValue = <TRole extends string = string>({
  routeConfig,
}: {
  routeConfig: RouteConfig<TRole>;
}): RouteConfigContextType<TRole> => {
  const { permissions, defaultRoutes, fallbackRoute } = routeConfig;

  const canRoleAccess = (path: string, role: string | null): boolean => {
    const requiredRoles = permissions[path];
    if (requiredRoles === null || requiredRoles === undefined) return true;
    if (!role) return false;
    return requiredRoles.includes(role as TRole);
  };

  return {
    config: routeConfig,
    isProtectedRoute: (path: string) => {
      const roles = permissions[path];
      return roles !== null && roles !== undefined;
    },
    getRequiredRoles: (path: string) => permissions[path] ?? null,
    canRoleAccess,
    getRedirectPath: (role: string, returnTo?: string) => {
      if (returnTo && canRoleAccess(returnTo, role)) return returnTo;
      return defaultRoutes[role as TRole] ?? fallbackRoute;
    },
  };
};

/**
 * Main application provider. Wraps the app with:
 * - AuthProvider (authentication state + proactive token refresh)
 * - RouteConfigContext (route access control)
 *
 * Bring your own GraphQL client. Wire it via `getAccessToken`,
 * `subscribeAccessToken`, and `ensureFreshToken` from the public API.
 *
 * @example
 * ```tsx
 * const routeConfig: RouteConfig = {
 *   permissions: { "/": null, "/dashboard": ["admin", "judge"] },
 *   defaultRoutes: { admin: "/dashboard", judge: "/dashboard" },
 *   fallbackRoute: "/dashboard",
 * };
 *
 * <AppProvider
 *   routeConfig={routeConfig}
 *   onLogout={() => apolloClient.clearStore()}
 *   onTokenRefresh={() => wsClient.terminate()}
 * >
 *   <App />
 * </AppProvider>
 * ```
 */
export function AppProvider<TRole extends string = string>({
  children,
  routeConfig,
  onAuthChange,
  onLogout,
  onTokenRefresh,
  loadingFallback,
  httpUri,
  includeCredentials,
}: AppProviderProps<TRole>) {
  const config = useMemo(() => configValue({ routeConfig }), [routeConfig]);

  return (
    <AuthProvider
      onAuthChange={onAuthChange}
      onLogout={onLogout}
      onTokenRefresh={onTokenRefresh}
      loadingFallback={loadingFallback}
      httpUri={httpUri}
      includeCredentials={includeCredentials}
    >
      <RouteConfigContext.Provider value={config as RouteConfigContextType<string>}>
        {children}
      </RouteConfigContext.Provider>
    </AuthProvider>
  );
}

/**
 * Hook to check if current user can access a specific route.
 */
export function useCanAccess(path: string): boolean {
  const { isAuthenticated, hasAnyRole } = useAuth();
  const { getRequiredRoles } = useRouteConfig();
  const requiredRoles = getRequiredRoles(path);

  if (!requiredRoles) return true;
  if (!isAuthenticated) return false;
  return hasAnyRole(requiredRoles);
}
