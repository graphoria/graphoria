# React SDK

> **See also:** [Authentication](./AUTHENTICATION.md) | [Subscriptions](./SUBSCRIPTIONS.md)

`@graphoria/react` is a client-agnostic React companion to the Graphoria server. It owns the auth lifecycle (`auth_login` / `auth_refresh` / `auth_logout`, proactive token refresh, single-flight 401 retry), a route-config helper that mirrors the role-based permission shape you set on the server, and a few render-gate components. It does **not** bundle a GraphQL client — bring your own (Apollo, urql, relay, raw `fetch`) and wire it via the exported token-store API.

## Install

```bash
bun add @graphoria/react
```

`react` is the only peer dependency.

## The minimum setup

```tsx
import { AppProvider } from "@graphoria/react";

type Role = "user" | "admin";

function App() {
  return (
    <AppProvider<Role>
      routeConfig={{
        permissions: {
          "/admin": ["admin"],
          "/dashboard": ["user", "admin"],
          "/login": null, // null = public route
        },
        defaultRoutes: {
          user: "/dashboard",
          admin: "/admin",
        },
        fallbackRoute: "/dashboard",
      }}
      httpUri="http://localhost:3000/graphql"
    >
      <YourGraphqlClientProvider>
        <YourRoutes />
      </YourGraphqlClientProvider>
    </AppProvider>
  );
}
```

`AppProvider` mounts the `AuthProvider` and the route-config context. Wrap your chosen GraphQL client's provider _inside_ it so the client can read tokens / events from this package. The `<TRole>` generic preserves your role enum end-to-end — `useAuth().user?.role` is typed as `Role`, and `useRouteConfig().getRedirectPath()` only accepts your real role values.

`AppProvider` also accepts `onAuthChange`, `onLogout`, `onTokenRefresh`, `loadingFallback`, and `includeCredentials` props. See the [package README](../packages/react/README.md) for full prop docs.

## `useAuth<TRole>()`

```tsx
import { useAuth } from "@graphoria/react";

function LoginForm() {
  const { login, isAuthenticated, isLoading, error, user } = useAuth<Role>();

  if (isLoading) return <Spinner />;
  if (isAuthenticated) return <p>Hi {user?.role}</p>;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        await login(data.get("username") as string, data.get("password") as string);
      }}
    >
      <input name="username" />
      <input name="password" type="password" />
      {error && <p className="error">{error}</p>}
      <button>Sign in</button>
    </form>
  );
}
```

The hook surface:

| Member            | Type                                            | Notes                                                                                |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `isAuthenticated` | `boolean`                                       | True after a successful login or refresh.                                            |
| `isLoading`       | `boolean`                                       | True during the initial mount until the first refresh attempt resolves.              |
| `user`            | `{ role: TRole } \| null`                       | Populated from the access token's `role` claim.                                      |
| `error`           | `string \| null`                                | Last error message from `login` / `refreshToken`.                                    |
| `login`           | `(username, password) => Promise<User \| null>` | Calls `auth_login` and stores the token in memory.                                   |
| `logout`          | `() => Promise<void>`                           | Calls `auth_logout` and clears local state. Does not redirect — wire that yourself.  |
| `hasRole`         | `(role: TRole) => boolean`                      | Convenience for `user?.role === role`.                                               |
| `hasAnyRole`      | `(roles: TRole[]) => boolean`                   | Convenience for `roles.includes(user?.role)`.                                        |
| `refreshToken`    | `() => Promise<boolean>`                        | Manually trigger a refresh. The hook also schedules automatic refresh before expiry. |

Tokens are kept in memory only — there is no `localStorage` write. This protects against XSS-driven token theft, at the cost of forcing a fresh `auth_refresh` call on every page reload (the refresh token is sent via a `httpOnly` cookie when present, so silent reauth still works).

## `useRouteConfig<TRole>()` and `useCanAccess()`

```tsx
import { useCanAccess, useRouteConfig } from "@graphoria/react";

function ProtectedRoute({ path, children }: { path: string; children: React.ReactNode }) {
  const canAccess = useCanAccess(path);
  const { getRedirectPath } = useRouteConfig<Role>();
  const { user } = useAuth<Role>();

  if (!canAccess) {
    return <Navigate to={user ? getRedirectPath(user.role) : "/login"} />;
  }
  return <>{children}</>;
}
```

`useCanAccess(path)` is a one-liner: `true` if the current user's role appears in the `permissions` map for that path (or the path is public).

The full hook surface:

```typescript
type RouteConfigContextType<TRole> = {
  config: RouteConfig<TRole>;
  isProtectedRoute: (path: string) => boolean;
  getRequiredRoles: (path: string) => TRole[] | null;
  canRoleAccess: (path: string, role: TRole | null) => boolean;
  getRedirectPath: (role: TRole, returnTo?: string) => string;
};
```

`getRedirectPath(role, returnTo?)` returns `defaultRoutes[role]` (or `fallbackRoute`) — useful after login, after authorization failures, or wherever a role-aware destination matters. Pass `returnTo` to preserve the user's intended destination across a login redirect.

## Render gates

For conditional UI without router coupling, the SDK ships three render-gate components: `Authorize`, `Authenticated`, `Unauthenticated`. Each renders `children` when its predicate holds and the optional `fallback` (default `null`) otherwise.

```tsx
import { Authorize, Authenticated, Unauthenticated } from "@graphoria/react";

function Nav() {
  return (
    <nav>
      <a href="/dashboard">Dashboard</a>
      <Authorize<Role> roles={["admin"]}>
        <a href="/admin">Admin</a>
      </Authorize>
      <Authenticated fallback={<a href="/login">Sign in</a>}>
        <LogoutButton />
      </Authenticated>
    </nav>
  );
}

function LandingPage() {
  return (
    <Unauthenticated fallback={<RedirectToDashboard />}>
      <MarketingHero />
    </Unauthenticated>
  );
}
```

| Component                        | Renders children when         |
| -------------------------------- | ----------------------------- |
| `<Authenticated>`                | `isAuthenticated` is `true`   |
| `<Unauthenticated>`              | `isAuthenticated` is `false`  |
| `<Authorize<TRole> roles={...}>` | `hasAnyRole(roles)` is `true` |

These don't replace `useCanAccess` — that one is path-scoped against your `permissions` map. The gates are role-scoped (`Authorize`) or auth-state-scoped (`Authenticated` / `Unauthenticated`). Use whichever matches the question you're asking.

Loading is handled at the provider boundary (`loadingFallback` on `AppProvider`), so by the time these gates render, `isLoading` is already `false` — they never flash unauthenticated content during initial boot.

## Hooking up your GraphQL client

The SDK is client-agnostic. Read the access token from the exported store and wire it into whatever client you use:

```ts
import { getAccessToken, subscribeAccessToken, ensureFreshToken } from "@graphoria/react";
```

| Function                        | Purpose                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `getAccessToken()`              | Synchronous read of the in-memory access token. Use in your auth link / fetch wrapper.         |
| `setAccessToken(token \| null)` | Set/clear the in-memory token. The SDK calls this internally on login/refresh/logout.          |
| `subscribeAccessToken(cb)`      | Subscribe to token changes (returns unsubscribe). Use this to restart a WebSocket on rotation. |
| `ensureFreshToken()`            | Single-flight refresh — call from your client's 401 handler. Deduplicates concurrent callers.  |

The package README has copy-pasteable integration recipes for [Apollo Client](../packages/react/README.md#apollo-client) and [urql](../packages/react/README.md#urql).

## Lower-level building blocks

If `AppProvider` is too opinionated, compose the pieces directly:

```tsx
import { AuthProvider, useAuth } from "@graphoria/react";

<AuthProvider
  httpUri="/graphql"
  onAuthChange={(user) => analytics.identify(user?.role)}
  onLogout={() => apolloClient.clearStore()}
>
  <YourGraphqlClientProvider>
    <YourRoutes />
  </YourGraphqlClientProvider>
</AuthProvider>;
```

`AuthProvider` gives you `useAuth` without the route-config context. Use this when you don't need RBAC route helpers, or when you're building your own route-config layer.

## Available exports

| Export                                          | Kind       |
| ----------------------------------------------- | ---------- |
| `AppProvider`                                   | component  |
| `AuthProvider`                                  | component  |
| `Authorize`, `Authenticated`, `Unauthenticated` | components |
| `useAuth<TRole>()`                              | hook       |
| `useRouteConfig<TRole>()`                       | hook       |
| `useCanAccess(path)`                            | hook       |
| `getAccessToken`, `setAccessToken`              | functions  |
| `subscribeAccessToken`, `ensureFreshToken`      | functions  |
| `GraphQLFetchError`                             | class      |

Types: `User`, `AuthState`, `AuthContextType`, `TokenResponse`, `RouteConfig`, `RouteConfigContextType`, `AuthTransportOptions`.

## Notes

- The SDK assumes the server's auth operations are the built-in `auth_login`, `auth_refresh`, `auth_logout`. If you've overridden them, copy the relevant chunk of `AuthContext.tsx` and substitute your operation names.
- `useAuth` proactively refreshes tokens ~30s before `expires_in` elapses; you don't need to add a timer yourself. `ensureFreshToken` is the reactive fallback for 401s caused by clock skew or server-side revocation.
- Tokens live **in memory only** — no `localStorage` write. Recovered on reload via `auth_refresh` if the server set the `httpOnly` refresh cookie.
- WebSocket subscriptions: your client owns the WS connection. Subscribe to token changes via `subscribeAccessToken` and call your client's WS-restart hook so reconnects pick up the rotated token.
