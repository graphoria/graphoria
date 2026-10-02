import type { QueueManager } from "../config/types/queue";
import type { QueueConfig } from "../types/zod/queue";

import { logger } from "../logging";
import { incMetric } from "../observability/metrics";
import { startSpan } from "../observability/tracing";

export type { QueuePublisher } from "../config/types/queue";

export type QueueRuntimeContext = {
  emitSubscriptionEvent: (key: string, payload: { data: unknown }) => void;
  cache: {
    invalidate: (operationName: string, pattern?: Record<string, unknown>) => Promise<boolean>;
  };
  logger: typeof logger;
  incMetric: typeof incMetric;
  startSpan: typeof startSpan;
};

export type QueueAdapter = {
  start: (queues: QueueConfig[], context: QueueRuntimeContext) => Promise<QueueManager>;
};

export type QueueAdapterType = "rabbitmq" | "kafka";
