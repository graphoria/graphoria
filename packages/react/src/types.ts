// ============================================================================
// Auth Types
// ============================================================================

export interface TokenResponse<TRole extends string = string> {
  access_token: string;
  expires_in: number; // seconds until access_token expires
  role: TRole;
}

export interface User<TRole extends string = string> {
  role: TRole;
}

export interface AuthState<TRole extends string = string> {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User<TRole> | null;
  error: string | null;
}

export interface AuthContextType<TRole extends string = string> extends AuthState<TRole> {
  login: (username: string, password: string) => Promise<User<TRole> | null>;
  logout: () => Promise<void>;
  hasRole: (role: TRole) => boolean;
  hasAnyRole: (roles: TRole[]) => boolean;
  /** Manually trigger a token refresh */
  refreshToken: () => Promise<boolean>;
}

// ============================================================================
// Route Configuration Types
// ============================================================================

export interface RouteConfig<TRole extends string = string> {
  /** Map of path to required roles (null = public) */
  permissions: Record<string, TRole[] | null>;
  /** Default route for each role after login */
  defaultRoutes: Partial<Record<TRole, string>>;
  /** Fallback route if role not in defaultRoutes */
  fallbackRoute: string;
}

// ============================================================================
// Auth Transport Options
// ============================================================================

export interface AuthTransportOptions {
  /** GraphQL HTTP endpoint for auth mutations (default: "/graphql") */
  httpUri?: string;
  /** Include credentials (cookies) in requests (default: true) */
  includeCredentials?: boolean;
}
