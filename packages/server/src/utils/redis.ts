import { RedisClient as ValkeyClient } from "bun";

import { logger } from "../logging";

const RECONNECT_INITIAL_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MULTIPLIER = 2;

export type RevivableRedisClient = {
  onclose: ((error: Error) => void) | null;
  connect(): Promise<void>;
};

export type KeepRedisConnectedOptions = {
  setTimeout?: typeof setTimeout;
};

/**
 * Bun's client reconnects on its own only until `maxRetries` runs out; then it
 * fires `onclose` and fails every later command with "Connection has failed",
 * even once the server is back. Only an explicit `connect()` revives it, so
 * that is what `onclose` schedules here, backing off while the server stays down.
 */
export const keepRedisConnected = (
  client: RevivableRedisClient,
  options: KeepRedisConnectedOptions = {},
) => {
  const log = logger("redis");
  const setTimeoutFn = options.setTimeout ?? setTimeout;

  let attempts = 0;
  let reconnecting = false;

  const scheduleReconnect = () => {
    if (reconnecting) return;
    reconnecting = true;

    const delay = Math.min(
      RECONNECT_INITIAL_DELAY * Math.pow(RECONNECT_MULTIPLIER, attempts),
      RECONNECT_MAX_DELAY,
    );
    attempts++;

    setTimeoutFn(() => {
      client.connect().then(
        () => {
          reconnecting = false;
          attempts = 0;
          log.info("reconnected");
        },
        (error: unknown) => {
          reconnecting = false;
          log.warn({ err: error, attempt: attempts }, "reconnect attempt failed");
          scheduleReconnect();
        },
      );
    }, delay).unref();
  };

  client.onclose = (error) => {
    if (reconnecting) return;
    log.warn({ err: error }, "connection lost, reconnecting");
    scheduleReconnect();
  };
};

export const createRedisClient = (url: string) => {
  const client = new ValkeyClient(url);
  keepRedisConnected(client);
  return client;
};
