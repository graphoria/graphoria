# Graphoria Documentation

Reference guides for configuring and running Graphoria. New here? Start with the [Quickstart](./QUICKSTART.md).

## Getting started

| Guide                                         | Description                                                           |
| --------------------------------------------- | --------------------------------------------------------------------- |
| [Quickstart](./QUICKSTART.md)                 | Zero to a running server in five minutes                              |
| [Configuration Reference](./CONFIGURATION.md) | Full configuration schema — databases, auth, operations, queues, cron |
| [API Reference](./API_REFERENCE.md)           | Complete package exports for server, config, and react                |

## Auth & access

| Guide                                            | Description                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| [Authentication](./AUTHENTICATION.md)            | JWT and PASETO strategies, argon2id passwords, refresh-token rotation |
| [Permissions & Access Control](./PERMISSIONS.md) | RBAC, row-level filtering, session variables, ordering                |

## Data

| Guide                                   | Description                                                      |
| --------------------------------------- | ---------------------------------------------------------------- |
| [Operations](./OPERATIONS.md)           | Custom query and handler operations, hooks, caching              |
| [GraphQL Directives](./DIRECTIVES.md)   | Built-in data-transformation and `@when` control-flow directives |
| [Virtual Columns](./VIRTUAL_COLUMNS.md) | Computed columns powered by SQL expressions or functions         |

## Realtime & integrations

| Guide                                         | Description                                                       |
| --------------------------------------------- | ----------------------------------------------------------------- |
| [Subscriptions](./SUBSCRIPTIONS.md)           | GraphQL subscriptions over WebSockets                             |
| [Queues](./QUEUES.md)                         | RabbitMQ and Kafka publishers, subscribers, cache invalidation    |
| [Cron Jobs](./CRON.md)                        | Scheduled background work with cron expressions and ISO datetimes |
| [Remote GraphQL Schemas](./REMOTE_SCHEMAS.md) | Stitch external GraphQL APIs into the unified schema              |
| [Remote REST APIs](./REMOTE_REST.md)          | Proxy external OpenAPI services under `/rest`                     |

## AI

| Guide                  | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| [AI Agent](./AI.md)    | Admin-only natural-language → database Q&A over GraphQL and REST  |
| [MCP Server](./MCP.md) | Model Context Protocol endpoint exposing read-only database tools |

## Frontend

| Guide                   | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| [React SDK](./REACT.md) | `@graphoria/react` hooks, providers, and Apollo integration |
