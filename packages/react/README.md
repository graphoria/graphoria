# @graphoria/react

Client-agnostic React auth + route helpers for Graphoria servers. Owns the auth lifecycle (`auth_login` / `auth_refresh` / `auth_logout`, proactive token refresh, single-flight 401 retry) and exposes a tiny event API your GraphQL client of choice — Apollo, urql, relay, raw fetch — plugs into.

> Full guide: [docs/REACT.md](../../docs/REACT.md).

## Install

```bash
bun add @graphoria/react
```

`react` is the only peer dependency. No GraphQL client is bundled — install the one you want separately.

## Quick start

```tsx
import { AppProvider, useAuth } from "@graphoria/react";

type Role = "user" | "admin";

function App() {
  return (
    <AppProvider<Role>
      httpUri="http://localhost:3000/graphql"
      routeConfig={{
        permissions: {
          "/admin": ["admin"],
          "/dashboard": ["user", "admin"],
          "/login": null,
        },
        defaultRoutes: { user: "/dashboard", admin: "/admin" },
        fallbackRoute: "/dashboard",
      }}
      onLogout={() => apolloClient.clearStore()}
      onTokenRefresh={() => wsClient.terminate()}
    >
      <YourGraphqlClientProvider>
        <YourRoutes />
      </YourGraphqlClientProvider>
    </AppProvider>
  );
}

function LoginButton() {
  const { login, isAuthenticated, error } = useAuth<Role>();
  if (isAuthenticated) return null;
  return (
    <>
      <button onClick={() => login("alice", "secret")}>Sign in</button>
      {error && <p>{error}</p>}
    </>
  );
}
```

`AppProvider` mounts the auth context and the route-config context. Wrap your chosen GraphQL client's provider _inside_ it so the client can read tokens / events from this package.

## Render gates

Three router-agnostic components for conditional UI based on auth state. All read from `useAuth`, all accept an optional `fallback` (defaults to `null`).

```tsx
import { Authorize, Authenticated, Unauthenticated } from "@graphoria/react";

<Authenticated fallback={<LoginPrompt />}>
  <Dashboard />
</Authenticated>

<Unauthenticated>
  <MarketingHero />
</Unauthenticated>

<Authorize<Role> roles={["admin"]} fallback={<NotAllowed />}>
  <AdminPanel />
</Authorize>
```

`<Authorize roles={[]}>` always renders `fallback` — i.e. an empty role list is "nobody is allowed".

## Public exports

| Export                     | Kind      | Purpose                                                                |
| -------------------------- | --------- | ---------------------------------------------------------------------- |
| `AppProvider`              | component | Combined Auth + Route-config provider.                                 |
| `AuthProvider`             | component | Just the auth context.                                                 |
| `useAuth<TRole>()`         | hook      | Auth state + `login` / `logout` / `refreshToken` / role checks.        |
| `useRouteConfig<TRole>()`  | hook      | Route permission helpers.                                              |
| `useCanAccess(path)`       | hook      | `boolean` — can the current user access `path`?                        |
| `Authorize`                | component | Renders children when the user has any of the given roles.             |
| `Authenticated`            | component | Renders children when the user is signed in.                           |
| `Unauthenticated`          | component | Renders children when the user is signed out.                          |
| `getAccessToken()`         | function  | Synchronous read of the in-memory access token. Use in your auth link. |
| `setAccessToken(token)`    | function  | Set/clear the in-memory access token (rare — usually internal).        |
| `subscribeAccessToken(cb)` | function  | Subscribe to token changes (returns unsubscribe). Use to restart WS.   |
| `ensureFreshToken()`       | function  | Single-flight refresh. Call from your client's 401 handler.            |
| `GraphQLFetchError`        | class     | Error thrown by built-in auth fetch (status, body, errors).            |

Types: `User`, `AuthState`, `AuthContextType`, `TokenResponse`, `RouteConfig`, `RouteConfigContextType`, `AuthTransportOptions`.

## Integration recipes

### Apollo Client

```ts
import { ApolloClient, ApolloLink, HttpLink, InMemoryCache, Observable } from "@apollo/client";
import { CombinedGraphQLErrors, ServerError } from "@apollo/client/errors";
import { SetContextLink } from "@apollo/client/link/context";
import { ErrorLink } from "@apollo/client/link/error";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";
import { getAccessToken, ensureFreshToken, subscribeAccessToken } from "@graphoria/react";

const authLink = new SetContextLink((_, ctx) => {
  const token = getAccessToken();
  return {
    headers: {
      ...(ctx as { headers?: Record<string, string> }).headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
});

const errorLink = new ErrorLink(({ error, operation, forward }) => {
  const is401 =
    (CombinedGraphQLErrors.is(error) &&
      error.errors.some((e) => e.extensions?.code === "UNAUTHENTICATED")) ||
    (ServerError.is(error) && error.statusCode === 401);
  if (!is401) return;

  return new Observable((observer) => {
    ensureFreshToken().then((ok) => {
      if (!ok) return observer.complete();
      forward(operation).subscribe(observer);
    });
  });
});

const wsClient = createClient({
  url: "ws://localhost:3000/graphql",
  connectionParams: () => {
    const t = getAccessToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  },
  retryAttempts: Infinity,
});
// Restart WS whenever the token rotates so subscriptions pick up new auth.
subscribeAccessToken(() => wsClient.terminate());

const httpChain = ApolloLink.from([
  errorLink,
  authLink,
  new HttpLink({
    uri: "/graphql",
    credentials: "include",
  }),
]);

const splitLink = ApolloLink.split(
  ({ query }) => {
    const d = getMainDefinition(query);
    return d.kind === "OperationDefinition" && d.operation === "subscription";
  },
  new GraphQLWsLink(wsClient),
  httpChain,
);

export const apolloClient = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
});
```

Wire `onLogout={() => apolloClient.clearStore()}` on `AppProvider`.

### urql

```ts
import { Client, cacheExchange, fetchExchange, subscriptionExchange } from "urql";
import { authExchange } from "@urql/exchange-auth";
import { createClient as createWsClient } from "graphql-ws";
import { getAccessToken, ensureFreshToken, subscribeAccessToken } from "@graphoria/react";

const wsClient = createWsClient({
  url: "ws://localhost:3000/graphql",
  connectionParams: () => {
    const t = getAccessToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  },
});
subscribeAccessToken(() => wsClient.terminate());

export const urqlClient = new Client({
  url: "/graphql",
  fetchOptions: { credentials: "include" },
  exchanges: [
    cacheExchange,
    authExchange(async () => ({
      addAuthToOperation(op) {
        const t = getAccessToken();
        if (!t) return op;
        const fetchOpts =
          typeof op.context.fetchOptions === "function"
            ? op.context.fetchOptions()
            : (op.context.fetchOptions ?? {});
        return {
          ...op,
          context: {
            ...op.context,
            fetchOptions: {
              ...fetchOpts,
              headers: {
                ...(fetchOpts.headers ?? {}),
                Authorization: `Bearer ${t}`,
              },
            },
          },
        };
      },
      didAuthError(err) {
        return (
          err.response?.status === 401 ||
          err.graphQLErrors.some((e) => e.extensions?.code === "UNAUTHENTICATED")
        );
      },
      async refreshAuth() {
        await ensureFreshToken();
      },
    })),
    fetchExchange,
    subscriptionExchange({
      forwardSubscription: (op) => ({
        subscribe: (sink) => ({
          unsubscribe: wsClient.subscribe(op, sink),
        }),
      }),
    }),
  ],
});
```

Wire `onLogout={() => urqlClient.reexecuteQuery(...)}` (or just unmount your Provider) on `AppProvider`.

## Notes

- Tokens live **in memory only** — no `localStorage` write. Recovered on reload via `auth_refresh` if the server set the `httpOnly` refresh cookie.
- The provider proactively refreshes ~30s before `expires_in` elapses. `ensureFreshToken` is the reactive fallback for 401s caused by clock skew or server-side revocation.
- `ensureFreshToken` deduplicates concurrent callers (one in-flight refresh shared across pending requests) and triggers logout on failure.
- `useAuth` and `useRouteConfig` must both be used inside `AppProvider` (or a manually composed `AuthProvider`).

## See also

- [React SDK guide](../../docs/REACT.md)
- [Authentication](../../docs/AUTHENTICATION.md)
- [Subscriptions](../../docs/SUBSCRIPTIONS.md)
