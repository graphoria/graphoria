# @graphoria/queues

RabbitMQ and Kafka adapter runtimes for [Graphoria](https://github.com/graphoria/graphoria).

```bash
bun add @graphoria/queues
```

The server discovers this package automatically at boot — no code change. If a queue is configured and the package is missing, boot fails with `queue type "…" requires @graphoria/queues (add it to dependencies)`.

## Adapter interface

| Export                                      | Meaning                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `registerQueueAdapters(setAdapter)`         | Registers both broker adapters with the server's registry                      |
| `startRabbitMQConnections(queues, context)` | RabbitMQ runtime: connection managers, publisher map, `sendMessage`, `cleanup` |
| `startKafkaConnections(queues, context)`    | Kafka runtime, same shape                                                      |

The server injects a `QueueRuntimeContext` — subscription delivery, cache invalidation, logger, metrics, and tracing — into each adapter at boot. Programmatic users can register adapters themselves via `setQueueAdapter(type, adapter)` from `@graphoria/server`; a registered adapter wins over a discovered one:

```typescript
import { registerQueueAdapters } from "@graphoria/queues";
import { setQueueAdapter } from "@graphoria/server";

registerQueueAdapters(setQueueAdapter);
```
