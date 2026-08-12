# GraphQL Subscriptions

> **See also:** [Queues](./QUEUES.md) | [React SDK](./REACT.md)

Graphoria implements GraphQL subscriptions over WebSockets using the [`graphql-ws`](https://github.com/enisdenjo/graphql-ws) protocol. The same `/graphql` URL accepts the WebSocket upgrade — there is no separate subscriptions endpoint. Subscriptions feed off the queue subscribers you've configured: every entry under `queues[].subscribers` becomes a GraphQL subscription that streams broker messages to connected clients.

## What's available to subscribe to

A `subscribers` entry in any queue config is automatically exposed as a subscription field, with the resolver name `${queueName}_${subscriberKey}`:

```typescript
queues: [
  {
    type: "rabbitmq",
    name: "events",
    /* … */
    subscribers: {
      orderUpdates: {
        topic: "orders",
        pattern: "order.*",
      },
    },
  },
],
```

Clients can now subscribe to `events_orderUpdates`:

```graphql
subscription {
  events_orderUpdates {
    id
    message
  }
}
```

The payload contains the deliveryTag and the message body as a string. Parse it client-side as needed (or attach a `handler` to the subscriber to pre-process messages on the server).

## Connecting from the client

The protocol is `graphql-ws` (sometimes called the "new" protocol; not the legacy `subscriptions-transport-ws`). Most modern clients support it out of the box: Apollo Client, urql, `graphql-ws` itself, Relay.

```typescript
import { createClient } from "graphql-ws";

const client = createClient({
  url: "ws://localhost:3000/graphql",
  connectionParams: {
    Authorization: `Bearer ${accessToken}`,
  },
});

const unsubscribe = client.subscribe(
  {
    query: `subscription { events_orderUpdates { id message } }`,
  },
  {
    next: (data) => console.log("event:", data),
    error: (err) => console.error(err),
    complete: () => console.log("done"),
  },
);
```

## Connection initialization

The handshake follows the standard graphql-ws sequence:

1. Client opens the WebSocket and sends `{ type: "connection_init", payload: { Authorization: "Bearer …" } }`.
2. Server verifies the token via the configured strategy (JWT or PASETO), establishes the role, and replies with `{ type: "connection_ack" }`.
3. Client sends `{ type: "subscribe", id: "<unique>", payload: { query, variables } }` per subscription.
4. Server emits `{ type: "next", id, payload }` for each event, and `{ type: "complete", id }` when the subscription ends.
5. Client (or server) sends `{ type: "complete", id }` to terminate a single subscription, or closes the WebSocket to terminate everything.

`payload.Authorization` and `payload.headers["x-admin-secret"]` are inspected during `connection_init`. Clients that omit both are treated as the anonymous role; the subscription's RBAC permissions are evaluated against that role at subscribe time.

## Pings and keepalives

Both ends can send `{ type: "ping" }`; Graphoria responds with `{ type: "pong" }`. Many proxies (NGINX, AWS ALB) close idle WebSockets after 60 seconds, so most clients ping every 20–30 seconds. The Apollo Client `keepAlive` option does this automatically.

## RBAC for subscriptions

A subscription is governed by the role established at `connection_init`. If the role doesn't have permission to call the underlying subscriber (via `permissions.<role>.queues`), the subscribe attempt returns an error and the WebSocket stays open for further attempts.

Note that authentication happens once per WebSocket — if the client's token expires mid-stream, the existing subscriptions continue. To force re-authentication, the client should disconnect and reconnect after refreshing.

## Patterns and pitfalls

- **Backpressure** — Graphoria currently has no built-in backpressure for slow consumers. A subscriber that processes events slowly may drop messages. If your stream is high-volume, terminate slow clients aggressively or aggregate events before sending.
- **Heartbeats** — let the client drive ping/pong. The server only responds to pings; it doesn't initiate them.
- **Multiple subscriptions on one socket** — each `subscribe` message has a unique `id`. Multiple concurrent subscriptions multiplex over the same WebSocket; cleaning one up doesn't affect others.
- **Reconnection** — the server doesn't rewind. After a reconnect, a client only sees events delivered after `connection_ack`. Persist offsets (Kafka) or use durable queues + manual ack (RabbitMQ) if you need at-least-once delivery across reconnects.
- **Broker-driven, not query-driven** — every subscription is sourced from a queue. To drive subscriptions from internal events (e.g. database changes, cron ticks), publish to a queue from the relevant code path and subscribe to that.
