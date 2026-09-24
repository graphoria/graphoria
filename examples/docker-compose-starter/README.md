# Docker Compose starter

A Graphoria project (`graphoria.ts`, `index.ts`, `package.json`, `bun.lock`) built into its own image and run next to Postgres. It is the [Quickstart](../../docs/QUICKSTART.md) in runnable form. For the full feature set (auth, queues, three databases, a frontend), see [Taskly](../taskly/).

## Run it

```bash
cd examples/docker-compose-starter
docker compose up -d --build
docker compose ps   # graphoria: (healthy)
```

- GraphiQL: http://localhost:3000/graphiql
- Scalar: http://localhost:3000/scalar
- Readiness: http://localhost:3000/health/ready

`seed.sql` creates `authors` and `books` (with a foreign key between them) and a few rows.

Auth is off, so an anonymous request sees no tables. Send the admin secret in `x-admin-secret`: `change-me` unless you set `ADMIN_SECRET` in the shell or in a `.env` next to `docker-compose.yml`. In GraphiQL, add it under Headers.

```bash
# A table
curl -s http://localhost:3000/graphql \
  -H 'x-admin-secret: change-me' -H 'content-type: application/json' \
  -d '{"query":"{ public_books(limit: 3) { title published_year } }"}'

# A relationship, through the books.author_id foreign key
curl -s http://localhost:3000/graphql \
  -H 'x-admin-secret: change-me' -H 'content-type: application/json' \
  -d '{"query":"{ public_authors { name public_books { title } } }"}'

# The REST operation declared in graphoria.ts
curl -s http://localhost:3000/rest/authors/2/books -H 'x-admin-secret: change-me'
```

`docker compose down -v` stops the stack and drops the database. The seed runs again on the next `up`.

## Version

`package.json` pins `@graphoria/server` to an exact version, and `bun.lock` locks it. It is bumped by hand after each release:

```bash
bun add --exact @graphoria/server@<version>
docker compose up -d --build
```

## Using the recipe in your own project

Copy `Dockerfile`, `.dockerignore` and `docker-compose.yml`. They rely on the following:

- `bun.lock` is committed, and `@graphoria/server` is in `dependencies`: the image runs `bun install --frozen-lockfile --production`.
- `.dockerignore` keeps `node_modules` and every `.env*` file out of the image. Bun loads `.env` from its working directory, so a baked-in one would carry secrets in a layer. Secrets come from the environment.
- `index.ts` passes no `port`. The server listens on `PORT` (default `3000`), and the healthcheck probes `PORT` and `PREFIX`.
- Compose runs the app with `init: true` (`docker run --init` outside Compose). Bun running as PID 1 ignores `SIGTERM`, so without an init `docker stop` waits 10 seconds and then kills it.
- The image runs as the non-root `bun` user, which cannot write under `/app`. Keep `PRINT_SCHEMAS` off, or point `SCHEMAS_OUTPUT_DIR` at a writable volume.
- Graphoria connects to its databases once at boot, with no retry. Keep a healthcheck on each database and `condition: service_healthy` on the app.
- Hosts come from the environment (`PG_HOST`), so the same `graphoria.ts` runs on the host (`localhost`) and in Compose (`postgres`).

Both stages are `oven/bun:<version>-slim`: Debian slim with Bun and no compiler. Keep the Bun version the same in both `FROM` lines. The `-distroless` variant lacks `libgcc_s`, which prebuilt native modules link against: `oxfmt` (a dependency of `@graphoria/server`, used when `PRINT_SCHEMAS` is on) and Tailwind's Bun plugin fail to load there.
