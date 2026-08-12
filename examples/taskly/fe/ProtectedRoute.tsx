// ============================================================================
// Protected Route Component
// ============================================================================

import { type ReactNode } from "react";
import { useLocation, Redirect } from "wouter";
import { useAuth, useRouteConfig } from "@graphoria/react";

interface ProtectedRouteProps {
  children: ReactNode;
  /** Required roles to access this route. If not specified, uses routeConfig */
  roles?: string[];
  /** Custom fallback for unauthorized (has auth but wrong role) */
  unauthorizedFallback?: ReactNode;
}

/**
 * Protects a route based on authentication and role requirements.
 * - If not authenticated → redirects to /login with return URL
 * - If authenticated but wrong role → shows unauthorized message
 * - If authenticated with correct role → renders children
 */
export function ProtectedRoute({ children, roles, unauthorizedFallback }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, user, hasAnyRole } = useAuth();
  const { isProtectedRoute, getRequiredRoles } = useRouteConfig();
  const [location] = useLocation();

  // Determine required roles (from props or route config)
  const requiredRoles = roles ?? getRequiredRoles(location);

  // If route doesn't require auth, render children
  if (!requiredRoles && !isProtectedRoute(location)) {
    return <>{children}</>;
  }

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  // Not authenticated → redirect to login
  if (!isAuthenticated) {
    const returnUrl = encodeURIComponent(location);
    return <Redirect to={`/login?returnTo=${returnUrl}`} />;
  }

  // Check role permissions
  if (requiredRoles && !hasAnyRole(requiredRoles)) {
    // Authenticated but unauthorized
    if (unauthorizedFallback) {
      return <>{unauthorizedFallback}</>;
    }

    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400">
        <div className="text-6xl mb-4">🚫</div>
        <h1 className="text-xl font-semibold text-white mb-2">Access Denied</h1>
        <p className="text-sm">You don't have permission to access this page.</p>
        <p className="text-xs mt-2 text-gray-500">
          Required role: {requiredRoles.join(" or ")} | Your role: {user?.role ?? "none"}
        </p>
      </div>
    );
  }

  // All checks passed
  return <>{children}</>;
}
