import type { QueueConnectionStatus, QueueManager } from "../config/types/queue";
import type { QueueAdapter, QueueAdapterType, QueueRuntimeContext } from "../queues/adapter";
import type { QueueConfig } from "../types/zod/queue";

import { queryEventEmitter } from "../configuration/gql/handleGraphQLSubscriptionFactory";
import { logger } from "../logging";
import { incMetric } from "../observability/metrics";
import { startSpan } from "../observability/tracing";
import { InvalidationHelper } from "./cache/registry";

export type { QueueConnectionStatus, QueueManager };

// One manager over the adapters' own: a publish goes to the one that has the publisher.
const combineManagers = (managers: QueueManager[]): QueueManager => ({
  publisherMap: () =>
    managers.reduce((acc, manager) => ({ ...acc, ...manager.publisherMap() }), {}),
  sendMessage: async (publisherName, message, key) => {
    for (const manager of managers) {
      if (manager.publisherMap()[publisherName]) {
        return await manager.sendMessage(publisherName, message, key);
      }
    }

    logger("queues").error(
      { publisher: publisherName },
      "publisher not found in any queue manager",
    );
    return false;
  },
  connections: () => managers.flatMap((manager) => manager.connections()),
  cleanup: async () => {
    await Promise.all(
      managers.filter((manager) => manager.cleanup).map((manager) => manager.cleanup!()),
    );
  },
});

// No queues until instantiateQueues runs, and none in createGraphQLEngine, which never runs it.
export let queueManager: QueueManager = combineManagers([]);

export const setQueueManager = (manager: QueueManager | undefined) => {
  queueManager = manager ?? combineManagers([]);
};

const adapters: Partial<Record<QueueAdapterType, QueueAdapter>> = {};

export const setQueueAdapter = (type: QueueAdapterType, adapter: QueueAdapter) => {
  adapters[type] = adapter;
};

type QueuesPackage = { registerQueueAdapters: (setAdapter: typeof setQueueAdapter) => void };

export type QueueDependencies = {
  /** Test seam: adapters are read from here instead of discovery. */
  adapters?: Partial<Record<QueueAdapterType, QueueAdapter>>;
  /** Test seam: discovery loads the package through this; `undefined` when it is not installed. */
  importQueues?: () => Promise<QueuesPackage | undefined>;
};

// Not a literal: TypeScript would follow the import into the package, whose
// @graphoria/server types resolve to this package's own dist (TS5055 on build).
const QUEUES_PACKAGE = "@graphoria/queues";

// Resolving first tells a missing package apart from one that fails to load: a
// load error (a broken install, a missing dependency of the package) surfaces as is.
const importQueuesPackage = async () => {
  try {
    import.meta.resolve(QUEUES_PACKAGE);
  } catch {
    return undefined;
  }
  return (await import(QUEUES_PACKAGE)) as QueuesPackage;
};

const discoverAdapters = async (
  types: QueueAdapterType[],
  available: Partial<Record<QueueAdapterType, QueueAdapter>>,
  importQueues: () => Promise<QueuesPackage | undefined>,
) => {
  const discovered: Partial<Record<QueueAdapterType, QueueAdapter>> = {};
  if (types.every((type) => available[type])) return discovered;

  const mod = await importQueues();
  mod?.registerQueueAdapters((type, adapter) => {
    discovered[type] = adapter;
  });

  const missing = types.filter((type) => !available[type] && !discovered[type]);
  if (missing.length > 0) {
    throw new Error(
      `queue type "${missing[0]}" requires @graphoria/queues (add it to dependencies)`,
    );
  }
  return discovered;
};

export const instantiateQueues = async (
  queues: QueueConfig[],
  { adapters: injected = {}, importQueues = importQueuesPackage }: QueueDependencies = {},
) => {
  const groups = new Map<QueueAdapterType, QueueConfig[]>();
  for (const queue of queues) {
    const group = groups.get(queue.type) ?? [];
    group.push(queue);
    groups.set(queue.type, group);
  }

  const available = { ...adapters, ...injected };
  const discovered = await discoverAdapters([...groups.keys()], available, importQueues);
  const resolved: Partial<Record<QueueAdapterType, QueueAdapter>> = {
    ...discovered,
    ...available,
  };

  const context: QueueRuntimeContext = {
    emitSubscriptionEvent: queryEventEmitter.sendDataUpdate,
    cache: InvalidationHelper,
    logger,
    incMetric,
    startSpan,
  };

  const managers: QueueManager[] = [];
  for (const [type, typeQueues] of groups) {
    managers.push(await resolved[type]!.start(typeQueues, context));
  }

  queueManager = combineManagers(managers);
};
