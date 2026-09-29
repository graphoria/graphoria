# Deploy to Kubernetes

The deployment guide's [Kubernetes example](../../docs/DEPLOYMENT.md#kubernetes-example) on a local [kind](https://kind.sigs.k8s.io/) cluster, with [Envoy Gateway](https://gateway.envoyproxy.io/) as the Gateway API implementation and the [starter project](../docker-compose-starter/) as the app.

| File                      | What it is                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `base/graphoria.yaml`     | The guide's manifest: Secret, Deployment, Service, PodDisruptionBudget, Gateway and HTTPRoute. A test keeps it identical to the guide. |
| `base/envoy-gateway.yaml` | The guide's Envoy Gateway policies: the client address, the upstream keep-alive and the body limit. Also kept identical to the guide.  |
| `kustomization.yaml`      | What differs for this local run: the image built from the starter, and the Secret's values.                                            |
| `gateway-class.yaml`      | The `eg` GatewayClass, with an `EnvoyProxy` that puts the gateway on node port 30443, since kind has no load balancer.                 |
| `postgres.yaml`           | A throwaway Postgres inside the cluster, seeded from the starter's `seed.sql`. The guide expects a managed database instead.           |
| `kind.yaml`               | One node on Kubernetes 1.34, with node port 30443 published on `127.0.0.1:8443`.                                                       |

## Run it

You need Docker, [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation), `kubectl` and `openssl`, and port 8443 free on the host.

```bash
cd examples/deploy-kubernetes

# A cluster, and Envoy Gateway, which brings the Gateway API CRDs
kind create cluster --config kind.yaml
kubectl apply --server-side -f https://github.com/envoyproxy/gateway/releases/download/v1.9.2/install.yaml
kubectl wait -n envoy-gateway-system deploy/envoy-gateway --for=condition=Available --timeout=5m

# The app's image, built from the starter and loaded into the node
docker build -t graphoria-starter:local ../docker-compose-starter
kind load docker-image graphoria-starter:local --name graphoria

# A self-signed certificate for api.example.com, and the database seed
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=api.example.com \
  -addext subjectAltName=DNS:api.example.com -keyout /tmp/graphoria-tls.key -out /tmp/graphoria-tls.crt
kubectl create secret tls graphoria-tls --cert /tmp/graphoria-tls.crt --key /tmp/graphoria-tls.key
kubectl create configmap seed --from-file=../docker-compose-starter/seed.sql

kubectl apply -k .
kubectl rollout status deploy/graphoria --timeout=4m
kubectl wait gateway/graphoria --for=condition=Programmed --timeout=2m
```

The seed ConfigMap is created by hand because kustomize reads no file outside this directory.

The gateway answers only for `api.example.com`, so `--resolve` stands in for DNS:

```bash
curl -s --resolve api.example.com:8443:127.0.0.1 --cacert /tmp/graphoria-tls.crt \
  https://api.example.com:8443/graphql \
  -H 'x-admin-secret: change-me' -H 'content-type: application/json' \
  -d '{"query":"{ public_books(limit: 3) { title published_year } }"}'

curl -s --resolve api.example.com:8443:127.0.0.1 --cacert /tmp/graphoria-tls.crt \
  https://api.example.com:8443/rest/authors/2/books -H 'x-admin-secret: change-me'
```

The starter has no auth, so an anonymous request sees no tables: send the admin secret, `change-me` as set in `kustomization.yaml`.

## What to expect

Measured on Linux with kind 0.30 and Envoy Gateway 1.9.2:

- Both replicas are ready about 12 seconds after `kubectl apply -k .`.
- `/graphql` and `/rest/*` answer. Every other path (`/health/*`, `/metrics`, `/_console`, `/openapi.json`, `/mcp`, `/graphiql`, `/scalar`, `/`) gets a `404`, and another host name fails the TLS handshake.
- A made-up `X-Forwarded-For` is dropped at the gateway: `actor.ip` is the address Envoy sees (here the kind network's gateway), with or without the header. Send a request with the admin secret, then read `actor` in `kubectl logs -l app=graphoria --tail=-1 | grep admin_secret.used`.
- A 2 MB body gets a `413`; subscriptions still connect (`wss://api.example.com:8443/graphql`).
- `kubectl rollout restart deploy/graphoria` under a serial loop of requests lost none of about 9,000, in each of two rollouts. With the `preStop` hook removed, the same test lost 6 to 14 per rollout: Envoy answered `503`, and a couple of requests timed out, while it still routed to pods that had stopped listening.
- `kubectl delete pod` returns after about 6 seconds: the 5-second `preStop`, then a drain. The container exits `0` and logs `shutdown complete {"clean":true}`.

## On a real cluster

- Apply the two files in `base/` with your image, your Secret values and your GatewayClass. The guide explains [each part](../../docs/DEPLOYMENT.md#kubernetes-example).
- Leave out `gateway-class.yaml`: your Gateway API implementation installs its GatewayClass, and your cloud's load balancer gives the Gateway an address to point DNS at.
- Leave out `postgres.yaml`: point `PG_HOST` in the Secret at a managed database.
- Take the certificate from your issuer (cert-manager, for example) instead of `openssl`, and keep real secret values out of git.

## Stop it

```bash
kind delete cluster --name graphoria
docker image rm graphoria-starter:local
rm /tmp/graphoria-tls.crt /tmp/graphoria-tls.key
```
