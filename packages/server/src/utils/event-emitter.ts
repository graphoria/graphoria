import type { ServerWebSocket } from "bun";
import type { GraphQLError } from "graphql";
import type { DatabasePoller } from "../subscriptions/types";

type EventEmitterData = {
  data: object | null;
  poll?: DatabasePoller;
  responseKey?: string;
  dataTransform?: (data: unknown) => unknown;
  clients: Map<ServerWebSocket<unknown>, string>;
};

export const createQueryEventEmitter = () => {
  const connections: Map<string, EventEmitterData> = new Map();
  // Maps a field key (e.g. "conn_queueName") to all composite subscription keys
  // that are registered under it. Used for queue fan-out.
  const fieldIndex: Map<string, Set<string>> = new Map();

  const addConnection = (
    queryName: string,
    id: string,
    ws: ServerWebSocket<unknown>,
    poll?: DatabasePoller,
  ) => {
    if (!connections.has(queryName)) {
      const clientsMap = new Map<ServerWebSocket<unknown>, string>();

      clientsMap.set(ws, id);

      connections.set(queryName, {
        poll,
        data: null,
        clients: clientsMap,
      });

      return;
    }

    if (poll) connections.get(queryName)!.poll = poll;

    connections.get(queryName)!.clients.set(ws, id);
  };

  const removeConnection = (ws: ServerWebSocket<unknown>) => {
    connections.entries().forEach(([queryName, con]) => {
      if (con.clients.has(ws)) {
        con.clients.delete(ws);

        if (con.clients.size === 0) {
          con.poll?.stop();
          connections.delete(queryName);
          // Clean up fieldIndex entries pointing to this subscriptionKey
          for (const [fieldKey, keys] of fieldIndex.entries()) {
            keys.delete(queryName);
            if (keys.size === 0) fieldIndex.delete(fieldKey);
          }
        }
      }
    });
  };

  const sendDataToWS = (data: object, ws: ServerWebSocket<unknown>) => {
    ws.send(JSON.stringify(data));
  };

  const sendDataByQueryNameToSingleClient = (
    queryName: string,
    ws: ServerWebSocket<unknown>,
    id: string,
  ) => {
    if (connections.has(queryName)) {
      const data = connections.get(queryName)!.data;

      if (data) sendDataToWS({ id, type: "next", payload: data }, ws);
    }
  };

  const sendDataUpdate = (queryName: string, data: object) => {
    // Fan-out path: if queryName is a field key registered in the index,
    // broadcast to each composite subscription key with its own transform.
    if (fieldIndex.has(queryName)) {
      for (const subscriptionKey of fieldIndex.get(queryName)!) {
        const conn = connections.get(subscriptionKey);
        if (!conn) continue;

        const rawData = (data as Record<string, unknown>).data;
        const transformed = conn.dataTransform ? conn.dataTransform(rawData) : rawData;
        const responseKey = conn.responseKey;

        conn.data = responseKey ? { data: { [responseKey]: transformed } } : { data: transformed };

        for (const [ws, id] of conn.clients) {
          sendDataByQueryNameToSingleClient(subscriptionKey, ws, id);
        }
      }
      return;
    }

    // Direct path: database strategy and other non-queue sources
    if (connections.has(queryName)) {
      const conn = connections.get(queryName)!;
      const responseKey = conn.responseKey;

      conn.data = responseKey
        ? { data: { [responseKey]: (data as Record<string, unknown>).data } }
        : data;

      if (conn.clients.size) {
        for (const [ws, id] of conn.clients) {
          sendDataByQueryNameToSingleClient(queryName, ws, id);
        }
      }
    }
  };

  const hasConnection = (queryName: string): boolean => {
    return connections.has(queryName) && connections.get(queryName)!.clients.size > 0;
  };

  const getConnectionCount = (queryName: string): number => {
    return connections.has(queryName) ? connections.get(queryName)!.clients.size : 0;
  };

  const setData = (queryName: string, data: object) => {
    if (connections.has(queryName)) {
      connections.get(queryName)!.data = data;
    }
  };

  const setPoll = (queryName: string, poll: DatabasePoller) => {
    if (connections.has(queryName)) {
      connections.get(queryName)!.poll = poll;
    }
  };

  const setResponseKey = (queryName: string, key: string) => {
    if (connections.has(queryName)) {
      connections.get(queryName)!.responseKey = key;
    }
  };

  const setDataTransform = (queryName: string, transform: (data: unknown) => unknown) => {
    if (connections.has(queryName)) {
      connections.get(queryName)!.dataTransform = transform;
    }
  };

  const registerFieldMapping = (fieldKey: string, subscriptionKey: string) => {
    if (!fieldIndex.has(fieldKey)) {
      fieldIndex.set(fieldKey, new Set());
    }
    fieldIndex.get(fieldKey)!.add(subscriptionKey);
  };

  const sendErrorToSingleClient = (
    ws: ServerWebSocket<unknown>,
    id: string,
    errors: readonly GraphQLError[],
  ) => {
    sendDataToWS(
      {
        id,
        type: "error",
        payload: errors.map((error) => ({
          message: error.message,
          locations: error.locations,
          path: error.path,
        })),
      },
      ws,
    );
  };

  const removeSubscription = (ws: ServerWebSocket<unknown>, subscriptionId: string) => {
    for (const [queryName, con] of connections.entries()) {
      if (con.clients.has(ws) && con.clients.get(ws) === subscriptionId) {
        con.clients.delete(ws);

        // Send complete message to client
        sendDataToWS(
          {
            id: subscriptionId,
            type: "complete",
          },
          ws,
        );

        if (con.clients.size === 0) {
          con.poll?.stop();
          connections.delete(queryName);
          // Clean up fieldIndex entries pointing to this subscriptionKey
          for (const [fieldKey, keys] of fieldIndex.entries()) {
            keys.delete(queryName);
            if (keys.size === 0) fieldIndex.delete(fieldKey);
          }
        }
        break;
      }
    }
  };

  return {
    addConnection,
    removeConnection,
    sendDataByQueryNameToSingleClient,
    sendDataUpdate,
    hasConnection,
    getConnectionCount,
    setData,
    setPoll,
    setResponseKey,
    setDataTransform,
    registerFieldMapping,
    sendErrorToSingleClient,
    removeSubscription,
  };
};
