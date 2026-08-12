# Message Queues

> **See also:** [Cron Jobs](./CRON.md) | [Permissions](./PERMISSIONS.md)

Graphoria has first-class integrations for [RabbitMQ](https://www.rabbitmq.com) and [Apache Kafka](https://kafka.apache.org). Both providers share the same configuration shape: you declare named publishers and subscribers, and Graphoria handles the connection, reconnection, exchange/topic setup, and resolver registration.

A publisher is exposed as a GraphQL mutation, so you can fan out events from any operation. A subscriber receives messages and can run arbitrary code — most commonly to invalidate cached operation results when an upstream event arrives.

## Configuring a queue

Every queue connection has a unique `name`, a provider-specific `connection` block, and one or both of `publishers` / `subscribers`. Topics (or exchanges, in RabbitMQ terminology) are auto-created from the topics referenced by publishers and subscribers.

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (() => ({
  name: "my-api",
  version: "1.0.0",
  databases: [
    /* … */
  ],
  queues: [
    {
      type: "rabbitmq",
      name: "events",
      enabled: true,
      autoSetup: true,
      connection: {
        hostname: "localhost",
        port: 5672,
        username: "guest",
        password: "guest",
        vhost: "/",
      },
      publishers: {
        orderCreated: {
          topic: "orders",
          routingKey: "order.created",
          persistent: true,
        },
      },
      subscribers: {
        invalidateProducts: {
          topic: "inventory",
          pattern: "product.*",
          handler: async (message, { cache }) => {
            await cache.invalidate("getProducts");
          },
        },
      },
      topics: {
        orders: { type: "topic", durable: true },
      },
    },
  ],
})) satisfies ConfigurationFn;
```

`autoSetup` (default `true`) means Graphoria asserts each exchange and queue exists at startup. Disable it if your infrastructure team owns the topology and you want the server to fail fast when something is missing.

`reconnect` is configurable per queue:

```typescript
reconnect: {
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  maxAttempts: 0,   // 0 = retry forever
}
```

The defaults (1s → 30s exponential backoff, infinite retries) are reasonable for most deployments. Failed connection attempts log a warning but do not crash the server, so a temporarily-unavailable broker won't take down the API.

## Publishers

A publisher is a named entry in the `publishers` map. Its key becomes the resolver name (prefixed with the queue name): the example above registers a GraphQL mutation `events_orderCreated`.

```graphql
mutation {
  events_orderCreated(message: { id: "ord_42", total: 9.99 }) {
    success
  }
}
```

The `message` argument accepts either a JSON object (which is serialized) or a raw string. Behind the scenes, Graphoria publishes to the exchange named `topic` with the configured `routingKey`. RabbitMQ's `persistent: true` ensures messages survive a broker restart.

You can also call publishers from operation handlers via `options.queues`:

```typescript
operations: {
  createOrder: operation({
    handler: async ({ queues }, input) => {
      const order = await /* … insert into DB … */;
      queues.events_orderCreated({ id: order.id, total: order.total });
      return order;
    },
  }),
}
```

Publishing returns a boolean — `true` if the message was accepted by the broker, `false` if the channel was unavailable. Graphoria logs failures, but it's still your job to decide whether a failed publish should fail the operation.

## Subscribers

A subscriber is a named entry in the `subscribers` map. The handler signature is:

```typescript
type SubscriberHandler = (
  message: unknown,
  context: {
    cache: {
      invalidate: (operationName: string, pattern?: Record<string, unknown>) => Promise<boolean>;
    };
  },
) => Promise<void> | void;
```

Graphoria parses the message body as JSON before calling your handler — if parsing fails, the raw string is passed through. The `cache.invalidate(operationName, pattern?)` helper is the cleanest way to keep cached operation results consistent with upstream changes:

```typescript
subscribers: {
  invalidateOnInventoryChange: {
    topic: "inventory",
    pattern: "product.*",
    handler: async (message, { cache }) => {
      const event = message as { sku: string };
      // Invalidate every cached call to getProducts
      await cache.invalidate("getProducts");
      // Or invalidate only specific cache entries by pattern match
      await cache.invalidate("getProductBySku", { sku: event.sku });
    },
  },
}
```

If the handler returns or resolves without throwing, Graphoria acks the message. If the handler throws, the message is `nack`ed — for RabbitMQ this means it goes back on the queue and will be redelivered until you ack it (so make sure your handler is either idempotent or has a poison-message strategy).

A subscriber is _also_ exposed as a GraphQL subscription with the same name: clients can stream messages without doing any of the broker plumbing themselves. See [Subscriptions](./SUBSCRIPTIONS.md) for the WebSocket protocol details.

## Permissions

Queues participate in RBAC. Use the `queues` permission key:

```typescript
permissions: {
  user: {
    operations: "ALL",
    queues: ["events"],          // can publish/subscribe to events_*
  },
  admin: { queues: "ALL" },
}
```

A role that can't access a queue won't see its publishers or subscribers in the GraphQL schema served to that role. Calls from disallowed roles fail with a permission error before reaching the broker.

## Provider notes

### RabbitMQ

`connection` accepts either an AMQP URL string (`amqp://user:pass@host:5672/vhost`) or an object with the fields shown above. Graphoria uses [`amqplib`](https://github.com/amqp-node/amqplib) under the hood. Each `topic` becomes an exchange, each `subscriber` declares a queue (with a generated name when you don't provide one), and bindings are created from the `pattern` field.

Routing-key patterns follow the standard AMQP topic-exchange syntax: `*` matches one word, `#` matches zero or more. The default pattern is `#` (everything).

### Kafka

`connection` accepts either a broker string (`"host:9092"` or comma-separated brokers) or an object with `brokers`, `ssl`, and `sasl`. SASL supports `plain`, `scram-sha-256`, and `scram-sha-512`.

For Kafka, `topic` is the topic name and `pattern` is ignored (Kafka filters at the consumer-group level, not message level). `group` controls the consumer group ID — pin it explicitly if you want consistent partition assignment across deployments.

`durable` and `autoDelete` only apply to RabbitMQ; the fields are accepted in Kafka configs for shape parity but ignored at runtime.

## Troubleshooting

| Symptom                                         | Likely cause                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `[RabbitMQ] Cannot send: channel not available` | The broker is unreachable. Reconnection is in progress — check logs.                                                                |
| Subscriber never receives messages              | The exchange exists but has no binding. Check `pattern` and `topic`.                                                                |
| Cache invalidation does nothing                 | The operation isn't actually cached. Add `cache: { ttl }` to the operation.                                                         |
| `Failed to publish message`                     | The publish call returned `false` from the underlying client; usually a closed channel.                                             |
| Handler throws, message keeps redelivering      | RabbitMQ redelivers `nack`ed messages by default. Wrap fallible work in a try/catch and ack-on-failure if redelivery isn't desired. |
