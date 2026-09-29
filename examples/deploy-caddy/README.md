# Deploy with Compose and Caddy

The [starter project](../docker-compose-starter/) on one host, behind [Caddy](https://caddyserver.com/). It is the [Reverse proxy and TLS](../../docs/DEPLOYMENT.md#reverse-proxy-and-tls) section of the deployment guide in runnable form: Caddy terminates TLS, passes only `/graphql` and `/rest` through, caps request bodies at 1 MB and retires its upstream connections before the server closes them.

| File                 | What it is                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `docker-compose.yml` | Postgres, the app built from [`../docker-compose-starter`](../docker-compose-starter/), and Caddy. Only Caddy publishes ports. |
| `Caddyfile`          | The guide's Caddyfile, with the site address taken from `SITE_ADDRESS` (default `localhost`).                                  |

## Run it

```bash
cd examples/deploy-caddy
docker compose up -d --build --wait
```

Caddy takes ports 80 and 443 on the host. With no `SITE_ADDRESS` it serves `localhost`, on a certificate from its own local CA. Copy that CA's root certificate out so that requests can verify it:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt /tmp/caddy-root.crt

curl -s --cacert /tmp/caddy-root.crt https://localhost/graphql \
  -H 'x-admin-secret: change-me' -H 'content-type: application/json' \
  -d '{"query":"{ public_books(limit: 3) { title published_year } }"}'

curl -s --cacert /tmp/caddy-root.crt https://localhost/rest/authors/2/books -H 'x-admin-secret: change-me'
```

The starter has no auth, so an anonymous request sees no tables: send the admin secret, `change-me` unless you set `ADMIN_SECRET` in the shell or in a `.env` next to `docker-compose.yml`. A browser warns about the certificate until the root is in its trust store.

## What to expect

Measured with Caddy 2.11:

- `/graphql` and `/rest/*` answer. Every other path (`/health/*`, `/metrics`, `/_console`, `/openapi.json`, `/mcp`, `/graphiql`, `/scalar`, `/`) gets a `404` from Caddy, and port 3000 is not published.
- `http://localhost/…` gets a `308` to `https://`.
- A request sent with a made-up `X-Forwarded-For` is recorded under the address Caddy sees (from the host, the Docker network's gateway), not the made-up one. Send it with the admin secret, then read `actor` in `docker compose logs graphoria | grep admin_secret.used`.
- A 2 MB body gets a `413` from Caddy; 900 KB goes through.
- Subscriptions connect through Caddy (`wss://localhost/graphql`) with no extra configuration.
- `docker compose stop` takes about half a second: the app logs `shutdown complete {"clean":true}` and exits `0`.

## Going to production

- Point a DNS name at the host, open ports 80 and 443, and set `SITE_ADDRESS` to that name, in the shell or in a `.env` next to `docker-compose.yml`. Caddy then gets a public certificate by itself ([automatic HTTPS](https://caddyserver.com/docs/automatic-https)); port 80 serves the ACME HTTP challenge and the redirect.
- Keep the `caddy_data` volume. It holds the certificates and the ACME account; without it Caddy asks for new certificates on every start.
- Set a real `ADMIN_SECRET` (`openssl rand -hex 32`). The database password (`postgres`, here and in the starter's `graphoria.ts`) is a local default: read it from the environment in your own project, as [Configuration and secrets](../../docs/DEPLOYMENT.md#configuration-and-secrets) describes.
- Processes, pools, Redis, backups and zero-downtime deploys are in the [deployment guide](../../docs/DEPLOYMENT.md).

## Stop it

```bash
docker compose down -v --rmi local
```

This removes the containers, the database, Caddy's certificates and the image built from the starter.
