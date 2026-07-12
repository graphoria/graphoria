import { useEffect, useMemo } from "react";
import { createGraphiQLFetcher, type Fetcher } from "@graphiql/toolkit";
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

function triggerSchemaRefetch(): void {
  setTimeout(() => {
    const button = [...document.querySelectorAll("button")].find((el) =>
      el.getAttribute("aria-label")?.includes("Re-fetch GraphQL schema"),
    );
    button?.focus();
    button?.click();
  }, 0);
}

export function useAuthFetcher(url: string | null): Fetcher | null {
  const fetcher = useMemo(() => {
    if (!url) return null;

    const wsClient = createClient({
      url: deriveWsUrl(url),
      connectionParams: () => {
        const token = getToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    });

    return createGraphiQLFetcher({
      url,
      fetch: createAuthFetch(),
      wsClient,
    });
  }, [url]);

  useEffect(() => {
    if (!fetcher) return;
    return subscribe(triggerSchemaRefetch);
  }, [fetcher]);

  return fetcher;
}
