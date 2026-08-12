# Authentication

> **See also:** [Permissions & Access Control](./PERMISSIONS.md) | [Configuration](./CONFIGURATION.md)

Graphoria ships with a complete authentication stack: a user table that lives in your database, password hashing with [argon2id](https://en.wikipedia.org/wiki/Argon2), token issuance and verification (JWT or PASETO), refresh-token rotation backed by Redis, and three built-in operations (`auth_login`, `auth_refresh`, `auth_logout`) that you can call from any client.

This guide covers each piece in the order you'll meet it.

## Enabling auth

Authentication is disabled by default. Add an `auth` block to your configuration:

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (({ operation }) => ({
  name: "my-api",
  version: "1.0.0",
  databases: [
    {
      name: "main",
      type: "pg",
      enabled: true,
      connection: {
        /* … */
      },
    },
  ],
  auth: {
    enabled: true,
    database: "main", // which database hosts the auth tables
    schema: "auth", // schema to use (default: "auth")
    autoCreateTables: true, // run CREATE SCHEMA / TABLE IF NOT EXISTS on boot
    permissions: {
      anonymous: { tables: "ALL", operations: "ALL" },
      user: {
        tables: {
          public_orders: {
            columns: "ALL",
            filter: { user_id: { eq: "$session.sub" } },
          },
        },
      },
      admin: { tables: "ALL", operations: "ALL" },
    },
  },
})) satisfies ConfigurationFn;
```

`auth.autoCreateTables` defaults to `false`. With it off, Graphoria runs a no-row probe (`SELECT username FROM auth.user WHERE 1=0`) at startup and aborts boot with a clear error if the table is missing — apply your schema migrations first, or flip `autoCreateTables: true` for the pre-1.0 behavior of running `CREATE SCHEMA / TABLE IF NOT EXISTS` on every boot. Either way you still need to create your first user (see _Bootstrapping users_ below).

The `permissions` map describes what each role is allowed to see. If a request arrives without a token, the role is `anonymous`. With a valid token, the role comes from the `role` column of the `user` table. With the admin secret header, the role is `superadmin` and bypasses all checks. Read [Permissions & Access Control](./PERMISSIONS.md) for the full filtering and column-level rules.

## The user table

Graphoria creates one table per auth schema:

| Column      | Type                               | Notes                                                                                                    |
| ----------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `username`  | `VARCHAR(50)` / `NVARCHAR(50)`     | Primary key. Must match `^[A-Za-z_][A-Za-z0-9_]*$` style strings; otherwise the database itself decides. |
| `password`  | `VARCHAR(255)` / `NVARCHAR(255)`   | Argon2id hash, stored as a single string.                                                                |
| `role`      | `VARCHAR(20)` / `NVARCHAR(20)`     | Maps to a key under `auth.permissions`.                                                                  |
| `is_active` | `BOOLEAN` / `BIT`                  | When `false`, login fails with "Invalid username or password" without exposing the cause.                |
| `claims`    | `JSONB` / `NVARCHAR(MAX)` / `JSON` | Arbitrary JSON object copied into the JWT/PASETO payload. Surfaced as `$session.<key>` at query time.    |

Passwords are verified with `Bun.password.verify`, which uses argon2id by default. Any hashing format Bun supports is accepted, so you can migrate from another scheme (bcrypt, scrypt, …) without re-hashing — Bun detects the format from the stored prefix.

### Bootstrapping users

Use the bundled CLI subcommand:

```bash
bunx graphoria seed-auth \
  --user alice \
  --password 's3cret' \
  --role admin \
  --config ./graphoria.ts \
  --claims '{"organizationId":"org_42"}'
```

| Flag         | Required | Notes                                                                        |
| ------------ | -------- | ---------------------------------------------------------------------------- |
| `--user`     | yes      | `username` PK on the auth user table.                                        |
| `--password` | yes      | Plaintext; the CLI hashes with argon2id (`Bun.password.hash`) before INSERT. |
| `--role`     | yes      | Must match a key in `auth.permissions`.                                      |
| `--config`   | yes      | Path to your `graphoria.ts`.                                                 |
| `--claims`   | no       | JSON object copied into the user's `claims` column.                          |

The same dispatcher backs the `bun run auth:seed` script for in-repo development. The auth user table must exist before seeding — either set `auth.autoCreateTables: true` and let the server provision it on first boot, or apply the schema yourself.

Anything you put in `claims` is later available as `$session.<key>` (or `$session.claims.<key>` depending on how you read it) in row-level filters. You can store the user's tenant ID, feature flags, or any other identity attribute that should travel with the token.

## Token strategies

Graphoria supports three token strategies. Pick one with `tokenStrategy` in your configuration:

```typescript
export default ({ operation }) => ({
  /* … */
  tokenStrategy: "paseto_local", // "jwt" (default) | "paseto_local" | "paseto_public"
});
```

Each strategy issues short-lived access tokens (`JWT_EXPIRES_IN`, default `5m`) and longer-lived refresh tokens (`JWT_RT_EXPIRES_IN`, default `7d`). Refresh tokens are single-use: the JTI is stored in Redis with the same TTL as the token itself, so a stolen refresh token can be replayed once at most before the legitimate user's next refresh invalidates it.

### `jwt` (default)

Symmetric HMAC-SHA256 tokens issued via [`jose`](https://github.com/panva/jose). Cheap to issue, cheap to verify, but anyone with `JWT_SECRET` can forge tokens. Suitable when both issuance and verification happen inside the same trust boundary.

| Variable            | Required | Notes                                             |
| ------------------- | -------- | ------------------------------------------------- |
| `JWT_SECRET`        | yes      | Any non-empty string. Use 32+ random bytes.       |
| `JWT_EXPIRES_IN`    | no       | Access-token lifetime, e.g. `15m`. Default `5m`.  |
| `JWT_RT_EXPIRES_IN` | no       | Refresh-token lifetime, e.g. `30d`. Default `7d`. |

### `paseto_local` (symmetric)

[PASETO v4.local](https://github.com/paseto-standard/paseto-spec) tokens — XChaCha20-Poly1305 authenticated encryption. The token body is opaque to clients, which is useful when you need to put confidential claims in the payload.

| Variable           | Required | Notes                                                                                  |
| ------------------ | -------- | -------------------------------------------------------------------------------------- |
| `PASETO_LOCAL_KEY` | yes      | A 32-byte key in PASETO `k4.local.…` format. Generate with `paseto-ts/v4`'s key tools. |

### `paseto_public` (asymmetric)

PASETO v4.public — Ed25519 signatures. Verifiers only need the public key, so this is the right choice when downstream services validate tokens but should not be able to issue them.

| Variable            | Required | Notes                           |
| ------------------- | -------- | ------------------------------- |
| `PASETO_SECRET_KEY` | yes      | `k4.secret.…` (signs tokens)    |
| `PASETO_PUBLIC_KEY` | yes      | `k4.public.…` (verifies tokens) |

If you start the server without the variables required for the chosen strategy, Graphoria fails fast with a clear error message — it will not silently fall back to a weaker strategy.

Setting the `AUTH_STRATEGY` env var to `jwt`, `paseto_local`, or `paseto_public` overrides whatever `tokenStrategy` is in the configuration file. This is intended for the case where the configuration is committed but the strategy varies per deploy (dev = JWT, prod = PASETO). The override is logged once at boot. Invalid values fail validation at startup.

## The built-in operations

When `auth.enabled` is `true`, Graphoria registers three GraphQL mutations and equivalent REST endpoints. They live alongside whatever you define in your `operations` block.

### `auth_login`

```graphql
mutation Login($username: String!, $password: String!) {
  auth_login(username: $username, password: $password) {
    access_token
    refresh_token
    expires_in
    role
  }
}
```

Returns `401` for unknown usernames, inactive users, or wrong passwords. The error message is intentionally generic ("Invalid username or password") so it cannot be used as a username oracle. `expires_in` is the access-token lifetime in seconds.

### `auth_refresh`

```graphql
mutation Refresh($refresh_token: String!) {
  auth_refresh(refresh_token: $refresh_token) {
    access_token
    refresh_token
    expires_in
    role
  }
}
```

Validates the refresh token, marks its JTI as used in Redis, and issues a brand-new pair. Reusing a refresh token throws `"Token reuse detected"` — surface this in your client as a forced logout, since it usually means either an honest race or a stolen token.

### `auth_logout`

Hard logout. Revokes the JTI of the access token used to make the request (read from the `Authorization` header) and the JTI of the refresh token cookie if present, then deletes the cookie. Any subsequent `verifyTokenAndGetSession` call for those JTIs returns the `anonymous` session, and any `auth_refresh` call for the revoked refresh token throws `"Token revoked"`. Revocation is recorded in the same Redis hash as the per-JTI replay-protection record, so it inherits the original token's TTL — there are no orphan keys.

Tampered or expired refresh cookies are handled gracefully: the verify step swallows the error and the cookie is still cleared.

## Sending tokens to the server

Pass the access token in the `Authorization` header (configurable via `AUTHORIZATION_HEADER`):

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  --data '{"query": "{ public_orders { id } }"}'
```

The admin secret bypasses normal auth — useful for migrations, internal tooling, or local development:

```bash
curl -X POST http://localhost:3000/graphql \
  -H "x-admin-secret: $ADMIN_SECRET" \
  --data '{"query": "{ public_orders { id } }"}'
```

The header name is configurable via `ADMIN_SECRET_HEADER`. The comparison uses `crypto.timingSafeEqual`, so you cannot probe for the value by measuring response times.

## Session variables in filters

Once a token is verified, the payload is exposed to your row-level filters as `$session.<claim>`:

```typescript
permissions: {
  user: {
    tables: {
      public_orders: {
        columns: "ALL",
        filter: { user_id: { eq: "$session.sub" } },
      },
      public_org_data: {
        columns: "ALL",
        filter: { org_id: { eq: "$session.organizationId" } },
      },
    },
  },
}
```

Standard claims (`sub`, `role`, `iat`, `exp`, `jti`, …) are always available. Anything you stored in the `claims` JSONB column is hoisted into the session as a top-level key. See [Permissions & Access Control](./PERMISSIONS.md) for nested access patterns.

## Operational notes

- **Redis** is required for refresh-token rotation. If Redis is unreachable, refresh attempts fail closed — the design choice favors security over availability.
- **Argon2id** parameters are inherited from Bun's defaults (`m=65536, t=2, p=1`). To tune them, hash passwords explicitly with `Bun.password.hash(plain, { algorithm: "argon2id", memoryCost, timeCost })` before inserting.
- **Token clock skew** is not currently configurable — the verifier rejects tokens whose `exp` is in the past or whose `nbf` is in the future, with no grace period.
- **Multi-tenant deployments** can store the tenant ID in `claims.tenant_id` and reference it as `$session.tenant_id` in every filter; the JWT/PASETO payload carries it on every request, so there's no extra DB round-trip.
