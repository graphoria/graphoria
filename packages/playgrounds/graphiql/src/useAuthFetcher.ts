import { useMemo, useSyncExternalStore } from "react";
import { createTransport, type Transport } from "@graphiql/toolkit";
import { createClient } from "graphql-ws";
import { createAuthFetch, getToken, subscribe } from "./auth";

function deriveWsUrl(httpUrl: string): string {
  if (/^wss?:\/\//i.test(httpUrl)) return httpUrl;
  if (/^https?:\/\//i.test(httpUrl)) {
    return httpUrl.replace(/^http/i, "ws");
  }
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = httpUrl.startsWith("/") ? httpUrl : `/${httpUrl}`;
  return `${wsProtocol}//${window.location.host}${path}`;
}

export function useAuthFetcher(url: string | null): Transport | null {
  // GraphiQL introspects whenever it gets a new transport, so a new token is what
  // reloads the schema for the role that just logged in or out.
  const token = useSyncExternalStore(subscribe, getToken);

  return useMemo(() => {
    if (!url) return null;

    const wsClient = createClient({
      url: deriveWsUrl(url),
      connectionParams: () => {
        const token = getToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    });

    return createTransport({
      url,
      fetch: createAuthFetch(),
      subscriptionClient: wsClient,
      // The endpoint serves POST only (GET is the websocket upgrade), and naming
      // the method skips the OPTIONS discovery the server has no Allow header for.
      supportedMethods: ["POST"],
    });
  }, [url, token]);
}
