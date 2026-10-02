# Message Queues

> **See also:** [Cron Jobs](./CRON.md) | [Permissions](./PERMISSIONS.md)

Graphoria has first-class integrations for [RabbitMQ](https://www.rabbitmq.com) and [Apache Kafka](https://kafka.apache.org). Both providers share the same configuration shape: you declare named publishers and subscribers, and Graphoria handles the connection, reconnection, exchange setup (RabbitMQ), and resolver registration.

A publisher is exposed as a GraphQL mutation, so you can fan out events from any operation. A subscriber receives messages and can run arbitrary code — most commonly to invalidate cached operation results when an upstream event arrives.

## Installing the adapters

The broker runtimes ship in a separate package:

```bash
bun add @graphoria/queues
```

Install the version that matches your `@graphoria/server`: each package pins the other exactly, and a mismatched pair warns at install.

Adapters are discovered automatically at boot — no code change. If a configuration declares a queue and the package is missing, boot fails with:

```
queue type "rabbitmq" requires @graphoria/queues (add it to dependencies)
```

Programmatic users can register adapters explicitly instead of relying on discovery, via the `setQueueAdapter(type, adapter)` function exported from `@graphoria/server`. A registered adapter wins over a discovered one:

```typescript
import { registerQueueAdapters } from "@graphoria/queues";
import { createBunServer, setQueueAdapter } from "@graphoria/server";

registerQueueAdapters(setQueueAdapter);
await createBunServer();
```

## Configuring a queue

Every queue connection has a unique `name`, a provider-specific `connection` block, and one or both of `publishers` / `subscribers`. Every topic a publisher or subscriber names must be declared under `topics`. On RabbitMQ a topic is an exchange, which Graphoria declares at startup; Kafka topics are created by the broker on first use (its default `auto.create.topics.enable`) or by you.

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (() => ({
  name: "my-api",
  version: "1.0.0",
  databases: [/* … */],
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
        inventory: { type: "topic", durable: true },
      },
    },
  ],
})) satisfies ConfigurationFn;
```

`enabled: false` turns a queue off: it does not connect, and its publishers and subscribers are left out of the schema.

`autoSetup` (default `true`, RabbitMQ only) means Graphoria declares each exchange and named queue, and binds the queues, at startup. Disable it if your infrastructure team owns the topology: a missing named queue then fails the setup instead of being created, which is logged and retried while `/health/ready` answers 503, and a publish to a missing exchange answers `false`. A subscriber without `queue` still declares its generated queue and binds it to the exchange, which must exist.

`reconnect` is configurable per queue:

```typescript
reconnect: {
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  maxAttempts: 0,   // 0 = retry forever
}
```

The wait before the n-th reconnect is `initialDelay × multiplier^(n-1)`, capped at `maxDelay`; without `reconnect` the defaults above apply (1s → 30s exponential backoff, forever). A failed attempt logs `connection failed` at `error` level but does not crash the server, so a temporarily-unavailable broker won't take down the API. With `maxAttempts: N`, a queue whose N reconnects in a row have failed logs `giving up reconnecting` once and stays down, `/health/ready` answering 503, until the server restarts; a successful connection resets the count.

## Publishers

A publisher is a named entry in the `publishers` map. Its key becomes the resolver name (prefixed with the queue name): the example above registers a GraphQL mutation `events_orderCreated`.

```graphql
mutation PublishOrder($data: String!) {
  events_orderCreated(data: $data)
}
```

with the variables `{ "data": "{\"id\":\"ord_42\",\"total\":9.99}" }`.

The mutation is `events_orderCreated(data: String!): Boolean!`. `data` is the message body, published as is: JSON-encode an object to send one. The mutation answers `true` when the broker took the message and `false` when it could not be sent. Behind the scenes, Graphoria publishes to the exchange named `topic` with the configured `routingKey`. RabbitMQ's `persistent: true` lets a message survive a broker restart in a durable queue.

Operation handlers, `init` hooks and cron ticks publish through `options.queues`, the queue manager: `sendMessage` takes the publisher's resolver name (`<queue>_<publisher>`), the message, and, on Kafka, an optional message key:

```typescript
operations: {
  createOrder: operation({
    handler: async ({ queues }, input) => {
      const order = await /* … insert into DB … */;
      await queues.sendMessage("events_orderCreated", { id: order.id, total: order.total });
      return order;
    },
  }),
}
```

Publishing returns a boolean — `true` once the broker has confirmed it took the message, `false` when the broker refused it, did not confirm it in time, or no connection was up. On RabbitMQ a publish waits up to 10 seconds for the broker's confirm; a message that no queue is bound for is still taken, then dropped. A broker in a memory or disk alarm blocks publishers and confirms only once the alarm clears, so a publish during one answers `false` after those 10 seconds, though the broker may still take the message when the alarm ends. Graphoria logs failures, but it's still your job to decide whether a failed publish should fail the operation.

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

A subscriber handles one message at a time on both brokers: RabbitMQ sends it the next message once the handler has finished with the last (a prefetch of one), and kafkajs runs one message at a time per consumer. A handler slower than the messages arrive leaves the rest waiting on the broker.

If the handler returns or resolves without throwing, Graphoria acks the message. If it throws, RabbitMQ puts the message back on the queue once; when the redelivered message fails again, it is dropped, or dead-lettered if a policy gives the queue a dead-letter exchange. A failed message therefore reaches the handler, and the GraphQL subscription, twice: keep handlers idempotent. On Kafka, a handler that throws is logged and counted, and the offset is still committed: the message is not redelivered.

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

A role that can't access a queue won't see its publishers or subscribers in the GraphQL schema served to that role. A call from a disallowed role fails GraphQL validation, since the field is not in its schema, and never reaches the broker.

## Provider notes

### RabbitMQ

`connection` accepts either an AMQP URL string (`amqp://user:pass@host:5672/vhost`) or an object with the fields shown above. Graphoria uses [`amqplib`](https://github.com/amqp-node/amqplib) under the hood. Each `topic` becomes an exchange, each `subscriber` consumes a queue (with a generated name when you don't provide one), bound with its `pattern`.

Subscribers without an explicit `queue` declare the auto-generated queue `exclusive: true`, as RabbitMQ 4 removed transient non-exclusive queues. Override it with the `exclusive` option on the subscriber, within three limits:

- On RabbitMQ 4, an auto-generated queue with `exclusive: false` is rejected unless it is also `durable: true`.
- An exclusive queue serves one connection only: another process that declares or consumes it is refused (`RESOURCE_LOCKED`) and stays unready, `/health/ready` answering 503. Leave a named queue that several processes share non-exclusive.
- RabbitMQ 4 makes an exclusive queue transient whatever `durable` says: it is deleted with its connection, so the messages published while the server reconnects are lost.

Routing-key patterns follow the standard AMQP topic-exchange syntax: `*` matches one word, `#` matches zero or more. The default pattern is `#` (everything).

### Kafka

`connection` accepts either a broker string (`"host:9092"` or comma-separated brokers) or an object with `brokers`, `ssl`, and `sasl`. SASL supports `plain`, `scram-sha-256`, and `scram-sha-512`.

For Kafka, `topic` is the topic name and `pattern` is ignored (Kafka filters at the consumer-group level, not message level). `group` is the consumer group: processes that share one split the topic's partitions, each message reaching one of them, and resume from the group's committed offsets. Without `group`, every connection joins a group of its own, so each process receives every message from the latest offset on, and misses what is published while it reconnects.

A publisher's `routingKey` is the message key; a `key` passed to `sendMessage` replaces it. Kafka keeps the messages of one key in one partition, in order. A message without a key goes to the topic's partitions in turn, so consumers may see unkeyed messages out of order.

`autoSetup` does not apply: Graphoria creates no topic. On a broker that creates topics on first use, the first setup of a subscriber on a new topic fails once (`UNKNOWN_TOPIC_OR_PARTITION`, logged as `connection failed`), and the reconnect a second later connects.

kafkajs retries an operation for about 10 seconds (5 retries from 300 ms, doubling) before it gives up. While the broker is away, a publish answers `false` after that, and a subscriber's consumer crashes, which turns `/health/ready` to 503 until the consumer rejoins its group. After a broker restart that can take up to the consumers' 30 s session timeout, while the group waits for the member that could not leave it. A queue with publishers only reports no outage: kafkajs gives no sign of a lost broker until a publish fails.

`durable`, `autoDelete` and `exclusive` only apply to RabbitMQ; the fields are accepted in Kafka configs for shape parity but ignored at runtime.

## Adapter interface

| Item                                | Shape / meaning                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueueAdapter`                      | `{ start(queues, context) → Promise<QueueManager> }` — one broker runtime; registered via `setQueueAdapter` or discovered from `@graphoria/queues`                                                                                                                                                                                                                                       |
| `QueueManager`                      | What `start` resolves to: `publisherMap()` (keyed `<queue>_<publisher>`; the server routes `sendMessage` by these keys), `sendMessage(publisher, message, key?)` (`true` when the broker took the message), `connections()` (`QueueConnectionStatus[]`, one `{ type, name, connected }` per queue, read by `/health/ready` and the console), and an optional `cleanup()` run at shutdown |
| `QueueRuntimeContext`               | Injected by the server at boot: `emitSubscriptionEvent` (subscription delivery), `cache.invalidate` (cache invalidation helper), `logger`, `incMetric` (metrics), `startSpan` (tracing)                                                                                                                                                                                                  |
| `registerQueueAdapters(setAdapter)` | `@graphoria/queues` export; registers both the RabbitMQ and the Kafka adapter with the server                                                                                                                                                                                                                                                                                            |

## Troubleshooting

| Symptom                                                                                            | Likely cause                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cannot send: channel not available` (`rabbitmq`), `cannot send: producer not available` (`kafka`) | No connection is up: the broker is unreachable, or the queue is between a lost connection and its reconnect. The `connection failed` and `scheduling reconnect` lines say which.                                                                                                                       |
| Subscriber never receives messages                                                                 | The exchange exists but has no binding. Check `pattern` and `topic`.                                                                                                                                                                                                                                   |
| Cache invalidation does nothing                                                                    | The operation isn't actually cached. Add `cache: { ttl }` to the operation.                                                                                                                                                                                                                            |
| `failed to publish message`                                                                        | The publish answered `false`. On RabbitMQ the broker refused the message, closed the channel first, or sent no confirm within 10 s (`message not confirmed`): a missing exchange closes the channel, and the queue reconnects. On Kafka, kafkajs gave up after its retries (`failed to send message`). |
| `connection blocked by the broker` (`rabbitmq`)                                                    | The broker is in a memory or disk alarm, named in the log's `reason`, and holds every publish until it clears: each answers `false` after 10 s. Free memory or disk on the broker.                                                                                                                     |
| A message reaches the handler twice                                                                | The handler threw the first time: a failed message is redelivered once, then dropped (or dead-lettered, under a policy).                                                                                                                                                                               |
| `TimeoutNegativeWarning: … is a negative number` on stderr (Kafka)                                 | Printed by Bun for KafkaJS's request queue, which computes a negative timeout while nothing is throttled. Harmless: the timer runs after 1 ms.                                                                                                                                                         |
| Boot fails: `queue type "…" requires @graphoria/queues`                                            | The config declares a queue but the adapter package is missing — install `@graphoria/queues`.                                                                                                                                                                                                          |
| Boot fails with an error from `@graphoria/queues`                                                  | The package is installed but cannot load (a broken install, a missing dependency): its own error says which. Reinstall it.                                                                                                                                                                             |
