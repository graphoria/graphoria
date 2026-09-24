# Examples

| Example                                                | What it shows                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docker-compose-starter/`](./docker-compose-starter/) | The [Quickstart](../docs/QUICKSTART.md) in runnable form: a project built into its own image, next to Postgres. Start here for the Docker recipe. |
| [`taskly/`](./taskly/)                                 | The full feature set: three databases, auth, queues, operations and a frontend.                                                                   |
| [`docker-compose.yml`](./docker-compose.yml)           | The local stack below: the backing services Graphoria can use, plus Taskly behind a profile.                                                      |

## Local stack

| Service    | Port(s)     | Credentials                                        | Needed for                             |
| ---------- | ----------- | -------------------------------------------------- | -------------------------------------- |
| Postgres   | 5432        | `postgres` / `postgrespassword`, db `my_app`       | a database Graphoria introspects       |
| MySQL      | 3306        | `root` / `mysqlpassword`, db `my_app`              | a database Graphoria introspects       |
| SQL Server | 1433        | `sa` / `Str0ng!Passw0rd`, db `my_app`              | a database Graphoria introspects       |
| Redis      | 6379        | none                                               | auth token store / `CACHE_STORE=redis` |
| RabbitMQ   | 5672, 15672 | `guest` / `guest`                                  | message-queue features (optional)      |
| DbGate     | 9000        | none                                               | a web UI over the three databases      |
| Taskly     | 3000        | see [`taskly/.env.example`](./taskly/.env.example) | only with `--profile taskly`           |

`mssql-init` is a one-shot service that creates the `my_app` database on SQL Server, which does not create it itself.

## Usage

```bash
docker compose -f docker-compose.yml up -d
```

Run your Graphoria server on the host against it, or run Taskly in its own image as well (it takes port 3000, so stop a host-run Taskly first):

```bash
docker compose -f docker-compose.yml --profile taskly up -d --build
```

Tear everything down, including the database volumes:

```bash
docker compose -f docker-compose.yml --profile taskly down -v
```
