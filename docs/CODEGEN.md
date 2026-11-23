# Codegen

> **See also:** [Quickstart](./QUICKSTART.md) | [tRPC](./TRPC.md) | [Deployment](./DEPLOYMENT.md)

`graphoria codegen` writes what Graphoria would expose for a `graphoria.ts`, from the configuration and the databases' structure, without starting the server.

## Usage

```bash
bunx graphoria codegen [--config <path>] [--out <dir>]
```

| Flag             | Default                                | Notes                                       |
| ---------------- | -------------------------------------- | ------------------------------------------- |
| `--config`, `-c` | `CONFIGURATION`, then `./graphoria.ts` | As the server's `-c`                        |
| `--out`          | `OUTPUT_DIR`, then `./.graphoria`      | The directory for `schemas/` and `openapi/` |

## Outputs

| File                                  | Holds                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `<out>/schemas/schema_<role>.graphql` | The role's GraphQL SDL, byte for byte what `PRINT_SCHEMAS` writes                |
| `<out>/openapi/openapi_<role>.json`   | The role's OpenAPI document; the superadmin's is what `GET /openapi.json` serves |

The files are written in place once everything is computed, so a failure before the writes writes nothing. The files of a role no longer configured are deleted. A write that fails exits 1, naming the path; the files written before it stay, and the next run repairs them. Keep `.graphoria` out of git: `init` lists it in `.gitignore`.

## What it runs

Only what the outputs need:

- the configuration module, its top level and its default function
- each enabled database's connection, with its `onConnect` hook and its `repository` factory
- the introspection reads
- the remote schema and remote REST resolution

It starts no HTTP listener, queue broker, cron job or AI agent. It creates no Redis client and no token service, and creates or checks no auth table. It drops each operation's `cache` before the analysis, since a Redis store connects when it is built.

## Environment

It needs no `ADMIN_SECRET` and no `.env`; Bun loads `.env` when there is one. What changes the outputs:

- `CONFIGURATION`, `SUPERADMIN_ROLE`, `ANONYMOUS_ROLE`
- `PREFIX` and `REST_API_PREFIX` (the OpenAPI `servers` URL), `ADMIN_SECRET_HEADER` (the admin security scheme)
- `AI_ENABLED`, `AI_GRAPHQL_ENABLED` (`ask` in the SDL), `AI_REST_ENABLED` (the agent's path in OpenAPI)
- `OUTPUT_DIR`: where it writes, not what

`QUERY_TIMEOUT_MS` does not apply: codegen sets no statement timeout.

Every variable `graphoria.ts` reads must be set too, including one for a service codegen never contacts: the config's top level and default function run. A scaffold's `env()` throws on an unset variable, `REDIS_URL` and `RABBITMQ_*` included.

It logs at `warn` unless `LOG_LEVEL` is set. `SCHEMAS_OUTPUT_DIR` is deprecated and ignored, with a `warn`. A scaffold's gql.tada plugin reads `./.graphoria/schemas/` (`tsconfig.json`): a project that sets `OUTPUT_DIR` updates that path.

## Output

On success, it prints `wrote <path>` for each file.

## Errors

| Case                                                              | Behaviour                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| An unknown flag or a missing value                                | the usage, exit 2                                                                        |
| `SUPERADMIN_ROLE` equal to `ANONYMOUS_ROLE`                       | the server's error, exit 1, nothing written                                              |
| The config fails to load or validate                              | exit 1, nothing written                                                                  |
| A database is unreachable                                         | exit 1, nothing written; a network engine retries for `DB_CONNECT_RETRY_MS` (60 s) first |
| The config names missing tables                                   | exit 1, nothing written                                                                  |
| A remote schema or remote REST API does not resolve               | exit 1, each one named, nothing written; the server warns and boots without it           |
| A queue without `@graphoria/queues`, `ai` without `@graphoria/ai` | no error: codegen loads neither. The SDL holds `ask`, while the server refuses to boot   |
| An output path is not writable                                    | exit 1, the path named                                                                   |
