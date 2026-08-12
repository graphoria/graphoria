# Example: local stack

A `docker-compose.yml` that starts the backing services Graphoria can use.

| Service  | Port(s)     | Needed for                                    |
| -------- | ----------- | --------------------------------------------- |
| Postgres | 5432        | the database Graphoria introspects (required) |
| Redis    | 6379        | auth token store / `CACHE_STORE=redis`        |
| RabbitMQ | 5672, 15672 | message-queue features (optional)             |

## Usage

```bash
docker compose -f docker-compose.yml up -d
```

These credentials match the [Quickstart](../docs/QUICKSTART.md) config:

```
host: localhost   port: 5432   user: postgres   password: postgres   database: my_app
```

Tear everything down, including the database volume:

```bash
docker compose -f docker-compose.yml down -v
```
