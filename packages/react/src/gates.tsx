import type { ReactNode } from "react";

import { useAuth } from "./AuthContext";

interface AuthorizeProps<TRole extends string> {
  roles: TRole[];
  fallback?: ReactNode;
  children: ReactNode;
}

export function Authorize<TRole extends string = string>({
  roles,
  fallback = null,
  children,
}: AuthorizeProps<TRole>) {
  const { hasAnyRole } = useAuth<TRole>();
  return <>{hasAnyRole(roles) ? children : fallback}</>;
}

interface GateProps {
  fallback?: ReactNode;
  children: ReactNode;
}

export function Authenticated({ fallback = null, children }: GateProps) {
  const { isAuthenticated } = useAuth();
  return <>{isAuthenticated ? children : fallback}</>;
}

export function Unauthenticated({ fallback = null, children }: GateProps) {
  const { isAuthenticated } = useAuth();
  return <>{isAuthenticated ? fallback : children}</>;
}
