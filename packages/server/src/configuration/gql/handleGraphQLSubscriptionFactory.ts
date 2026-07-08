import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { AnalyzedConfiguration } from "../../configuration";
import type { SubscriptionContext } from "../../subscriptions";
import type { SessionContext } from "../../utils/sessionVariables";

import { analyzeQuery } from "../../analyzeQuery";
import { resolveVariables } from "../../analyzeQuery/resolveVariables";
import { getTokenService } from "../../singletons/authentication";
import { createSubscriptionStrategyRegistry, getStrategyForSource } from "../../subscriptions";
import { createQueryEventEmitter } from "../../utils/event-emitter";
import { logger } from "../../logging";

export const queryEventEmitter = createQueryEventEmitter();

// Create the strategy registry once at module load
const strategyRegistry = createSubscriptionStrategyRegistry();

/**
 * Handle GraphQL subscription messages
 *
 * This factory creates a WebSocket message handler that:
 * 1. Handles the graphql-ws protocol (connection_init, ping, subscribe, complete)
 * 2. Delegates subscription logic to source-specific strategies
 */
const handleGraphQLSubscriptionFactory = (
  roles: AnalyzedConfiguration["roles"],
  subscriptionMapping: Map<ServerWebSocket<unknown>, SessionContext>,
  activeSubscriptions: Map<
    string,
    {
      ws: ServerWebSocket<unknown>;
      operationName: string;
      cleanup?: () => void | Promise<void>;
    }
  >,
) => {
  return async (ws: ServerWebSocket<unknown>, body: string) => {
    try {
      const parsed = JSON.parse(body);
      const { id, type, payload } = parsed;

      // Validate message format
      if (!type) {
        ws.send(
          JSON.stringify({
            type: "connection_error",
            payload: { message: "Message must have a 'type' field" },
          }),
        );
        return;
      }

      // Handle connection_init
      if (type === "connection_init") {
        const session = await getTokenService().verifyTokenAndGetSession(
          payload?.Authorization,
          payload?.headers?.["x-admin-secret"],
        );

        subscriptionMapping.set(ws, session);

        logger("subscriptions").debug({ role: session.role }, "client connected");

        ws.send(
          JSON.stringify({
            type: "connection_ack",
          }),
        );
        return;
      }

      // Handle ping
      if (type === "ping") {
        ws.send(
          JSON.stringify({
            type: "pong",
          }),
        );
        return;
      }

      // Handle subscribe
      if (type === "subscribe") {
        if (!id) {
          ws.send(
            JSON.stringify({
              type: "connection_error",
              payload: { message: "Subscribe message must have an 'id' field" },
            }),
          );
          return;
        }

        const { query, variables, operationName } = payload ?? {};
        const session = subscriptionMapping.get(ws)!;
        const schemaEntity = roles[session.role!];

        // Validate query
        const { hasErrors, validationErrors } = schemaEntity.handlers.gql.hasErrors(query);

        if (hasErrors) {
          queryEventEmitter.sendErrorToSingleClient(ws, id, validationErrors);
          return;
        }

        // Analyze the query
        const analysis = analyzeQuery(query, schemaEntity, schemaEntity.schema);

        const operation = analysis.operations[0];
        const field = operation.fields[0];

        // Get the appropriate strategy based on field source
        const strategy = getStrategyForSource(strategyRegistry, field?.source);

        if (!strategy) {
          ws.send(
            JSON.stringify({
              id,
              type: "error",
              payload: [
                {
                  message: `Unsupported subscription source: ${field?.source}`,
                },
              ],
            }),
          );
          return;
        }

        // Resolve variables: flatten object-type vars and replace $session.* references
        let resolved;
        try {
          resolved = resolveVariables(operation, variables || {}, session);
        } catch (error) {
          ws.send(
            JSON.stringify({
              id,
              type: "error",
              payload: [
                {
                  message: error instanceof Error ? error.message : "Variable resolution failed",
                },
              ],
            }),
          );
          return;
        }

        // Build context for the strategy
        const context: SubscriptionContext = {
          ws,
          subscriptionId: id,
          analysis,
          field: resolved.fields[0],
          variableDefinitions: resolved.variables,
          variables: resolved.allVariables,
          schemaEntity,
          eventEmitter: queryEventEmitter,
        };

        // Execute the strategy (handles connection registration internally)
        const result = await strategy.subscribe(context);

        // Store the subscription only if it's a new connection
        if (!result.alreadyExists) {
          logger("subscriptions").debug(
            { operation: operationName || operation.name, subscriptionId: id },
            "subscribed",
          );
          activeSubscriptions.set(id, {
            ws,
            operationName: operationName || operation.name!,
            cleanup: result.cleanup,
          });
        }
      }

      // Handle complete
      if (type === "complete") {
        if (!id) {
          ws.send(
            JSON.stringify({
              type: "connection_error",
              payload: { message: "Complete message must have an 'id' field" },
            }),
          );
          return;
        }

        const subscription = activeSubscriptions.get(id);
        if (subscription) {
          logger("subscriptions").debug({ subscriptionId: id }, "unsubscribed");
          // Call cleanup if available
          if (subscription.cleanup) {
            await subscription.cleanup();
          }
          activeSubscriptions.delete(id);
        }
        queryEventEmitter.removeSubscription(ws, id);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        logger("subscriptions").warn({ err: error }, "syntax error in subscription message");
      } else {
        logger("subscriptions").error({ err: error }, "subscription handler error");
      }

      throw error;
    }
  };
};

export const websocketHandlerFactory = (
  roles: AnalyzedConfiguration["roles"],
): WebSocketHandler<unknown> => {
  const subscriptionMapping: Map<ServerWebSocket<unknown>, SessionContext> = new Map();
  const activeSubscriptions: Map<
    string,
    {
      ws: ServerWebSocket<unknown>;
      operationName: string;
      cleanup?: () => void | Promise<void>;
    }
  > = new Map();

  const handleGraphQLSubscription = handleGraphQLSubscriptionFactory(
    roles,
    subscriptionMapping,
    activeSubscriptions,
  );

  return {
    async message(ws, message) {
      handleGraphQLSubscription(ws, message as string);
    },
    close(ws) {
      logger("subscriptions").debug("client disconnected");
      // Clean up all subscriptions for this WebSocket
      for (const [subscriptionId, subscription] of activeSubscriptions.entries()) {
        if (subscription.ws === ws) {
          subscription.cleanup?.();
          activeSubscriptions.delete(subscriptionId);
        }
      }
      queryEventEmitter.removeConnection(ws);
      subscriptionMapping.delete(ws);
    },
  };
};
