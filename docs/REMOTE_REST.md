# Remote REST APIs

> **See also:** [Remote GraphQL Schemas](./REMOTE_SCHEMAS.md) | [Permissions](./PERMISSIONS.md)

Remote REST APIs let you mount external HTTP services into Graphoria's `/rest` namespace. Graphoria reads the upstream's OpenAPI document at startup, prefixes every path under your chosen subpath, merges the spec into the unified `/openapi.json` exposed by the server, and proxies live requests through to the remote at runtime.

The result: one base URL, one OpenAPI document, one place to apply auth — even if the underlying services are spread across half a dozen vendors.

## Configuration

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (() => ({
  name: "my-api",
  version: "1.0.0",
  databases: [
    /* … */
  ],
  remoteREST: [
    {
      name: "petstore",
      specUrl: "https://petstore.example.com/openapi.json",
      url: "https://petstore.example.com", // optional; falls back to spec.servers[0].url
      enabled: true,
      prefix: "petstore", // routes will live under /rest/petstore/...
      headers: { "X-Api-Key": process.env.PETSTORE_KEY! },
      forwardHeaders: ["authorization"],
      timeout: 5000,
    },
    {
      name: "billing",
      specPath: "./specs/billing.yaml", // OpenAPI YAML on disk
      url: "https://billing.internal",
      enabled: true,
      prefix: "billing",
    },
  ],
})) satisfies ConfigurationFn;
```

| Field            | Type                      | Notes                                                                                   |
| ---------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `name`           | `string`                  | Unique identifier — used in permissions, logs, and the OpenAPI tag.                     |
| `specUrl`        | `string?`                 | HTTP(S) URL to fetch the OpenAPI spec from at startup. JSON or YAML.                    |
| `specPath`       | `string?`                 | Filesystem path to a local spec. Useful for vendored specs or air-gapped environments.  |
| `url`            | `string?`                 | Base URL for runtime proxying. If omitted, Graphoria uses `spec.servers[0].url`.        |
| `enabled`        | `boolean?`                | Defaults to `true`. Disabled remotes are absent from both the spec and the route table. |
| `prefix`         | `string?`                 | The subpath under `/rest` where the remote lives. Defaults to `name`.                   |
| `headers`        | `Record<string, string>?` | Static headers attached to every proxied request.                                       |
| `forwardHeaders` | `string[]?`               | Names of headers from the incoming client request to forward upstream.                  |
| `timeout`        | `number?`                 | Per-request timeout in ms. Default `10000`.                                             |

Exactly one of `specUrl` or `specPath` must be provided. Both JSON and YAML are supported — YAML is parsed via Bun's built-in `Bun.YAML.parse`, so there's no extra dependency.

## What happens at startup

1. **Parse**: Graphoria fetches (or reads) the spec and parses it into an `OpenAPIV3_1.Document`.
2. **Transform**: every path is rewritten as `/{prefix}/<original>`. Component schemas are renamed `{prefix}_{Name}` and `$ref` strings are rewritten consistently. Routes are extracted into a flat list keyed by method and prefixed path.
3. **Resolve**: the prefixed paths and schemas are tagged for the merged OpenAPI document; the route list is registered with the REST handler.
4. **Merge**: when the server serves `/openapi.json`, the prefixed entries are merged into your unified spec under tags named after the remote (`petstore`, `billing`, …).

If the spec is unreachable or invalid, the server logs the failure and continues without that remote. Routes from successfully-loaded remotes still work.

## What happens at request time

When a request lands at `/rest/petstore/pets/42`:

1. The local route table is consulted first. If a matching local operation exists, it wins.
2. Otherwise, the remote-REST router (using `path-to-regexp`) matches the request against the prefixed routes extracted at startup.
3. The proxy substitutes path parameters into the _original_ path (`/pets/{petId}` → `/pets/42`), merges static `headers` with whatever `forwardHeaders` named, and reissues the request against the remote's base URL.
4. For `POST`/`PUT`/`PATCH`, the request body is streamed straight through — large uploads do not buffer in memory.
5. The remote response is returned to the client, with status code, headers, and body preserved.

## Permissions

Like remote schemas, remote REST APIs participate in role-based access control. Use the `remoteREST` permission key:

```typescript
permissions: {
  user: {
    operations: "ALL",
    remoteREST: ["petstore"],          // user can hit /rest/petstore/*
  },
  admin: {
    remoteREST: "ALL",                  // every remote REST API
  },
}
```

A role without the remote name in its `remoteREST` list cannot reach those routes. Permission checks run _before_ the proxy fires, so unauthorized requests do not consume an upstream call.

## Tips and gotchas

- **Prefix collisions**: if two remotes share a `prefix`, the second one wins for routes that overlap. Always assign a unique prefix per remote.
- **Local routes win**: define an operation with `rest: { path: "/petstore/health" }` and Graphoria will serve it locally even though `petstore` is mounted at the same path. This is how you can override or enrich a single upstream endpoint.
- **OpenAPI variants**: Graphoria expects OpenAPI 3.0 or 3.1. Swagger 2.0 specs need to be converted first (e.g. with `swagger2openapi`).
- **Auth forwarding**: the `Authorization` header is forwarded _only_ if you list it in `forwardHeaders`. Most internal upstreams trust the header as long as it matches their JWT issuer, so you typically want this on.
- **Timeouts**: `timeout` is enforced via `AbortController`. A timed-out upstream call returns `504 Gateway Timeout` to the client.
- **Streaming responses**: only request bodies are streamed; responses are buffered before being returned. For very large remote responses, consider exposing the upstream directly rather than proxying.
