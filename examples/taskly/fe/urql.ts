import { Client, cacheExchange, fetchExchange, subscriptionExchange } from "urql";
import { authExchange } from "@urql/exchange-auth";
import { createClient as createWsClient } from "graphql-ws";
import { getAccessToken, ensureFreshToken, subscribeAccessToken } from "@graphoria/react";

const HTTP_URI = "/graphql";
const WS_URI =
  (window.location.protocol === "https:" ? "wss:" : "ws:") +
  "//" +
  window.location.host +
  "/graphql";

export const wsClient = createWsClient({
  url: WS_URI,
  connectionParams: () => {
    const token = getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
  retryAttempts: Infinity,
  shouldRetry: () => true,
});

// Restart the socket whenever the token rotates so subscriptions
// re-handshake with the fresh credential.
subscribeAccessToken(() => wsClient.terminate());

export const urqlClient = new Client({
  url: HTTP_URI,
  fetchOptions: { credentials: "include" },
  preferGetMethod: false,
  exchanges: [
    cacheExchange,
    authExchange(async () => ({
      addAuthToOperation(operation) {
        const token = getAccessToken();
        if (!token) return operation;

        const prevFetchOptions =
          typeof operation.context.fetchOptions === "function"
            ? operation.context.fetchOptions()
            : (operation.context.fetchOptions ?? {});

        return {
          ...operation,
          context: {
            ...operation.context,
            fetchOptions: {
              ...prevFetchOptions,
              headers: {
                ...(prevFetchOptions.headers ?? {}),
                Authorization: `Bearer ${token}`,
              },
            },
          },
        };
      },
      didAuthError(error) {
        return (
          error.response?.status === 401 ||
          error.graphQLErrors.some(
            (e) =>
              e.extensions?.code === "UNAUTHENTICATED" ||
              e.message.toLowerCase().includes("unauthorized"),
          )
        );
      },
      async refreshAuth() {
        // Single-flight; if it returns false the package already
        // invoked the registered logout handler.
        console.log("refresh_token");

        await ensureFreshToken();
      },
    })),
    fetchExchange,
    subscriptionExchange({
      forwardSubscription: (request) => ({
        subscribe: (sink) => ({
          unsubscribe: wsClient.subscribe({ ...request, query: request.query ?? "" }, sink),
        }),
      }),
    }),
  ],
});
