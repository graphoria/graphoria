import { mock } from "bun:test";
import { setAccessToken, setLogoutHandler, setRefreshHandler } from "../tokenStore";
import { __resetBootRefreshCacheForTest } from "../AuthContext";

import type { TokenResponse } from "../types";

export interface FetchCall {
  uri: string;
  body: { query: string; variables?: Record<string, unknown> };
  init: RequestInit;
}

export interface MockFetch {
  fn: typeof fetch;
  calls: FetchCall[];
  queue: Array<() => Promise<Response>>;
  enqueueJson: (data: unknown, status?: number) => void;
  enqueueGraphQLData: (data: unknown) => void;
  enqueueNetworkError: (message?: string) => void;
  enqueueHttpError: (status: number, body?: string) => void;
  enqueueGraphQLErrors: (errors: Array<{ message: string }>, status?: number) => void;
}

export function makeMockFetch(): MockFetch {
  const calls: FetchCall[] = [];
  const queue: Array<() => Promise<Response>> = [];

  const fn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const uri = typeof input === "string" ? input : input.toString();
    const bodyText = (init?.body as string | undefined) ?? "{}";
    const body = JSON.parse(bodyText) as FetchCall["body"];
    calls.push({ uri, body, init: init ?? {} });

    const responder = queue.shift();
    if (!responder) {
      throw new Error(`mockFetch: no response queued for ${body.query.slice(0, 40)}...`);
    }
    return responder();
  }) as unknown as typeof fetch;

  return {
    fn,
    calls,
    queue,
    enqueueJson(data, status = 200) {
      queue.push(
        async () =>
          new Response(JSON.stringify(data), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      );
    },
    enqueueGraphQLData(data) {
      queue.push(
        async () =>
          new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
    },
    enqueueNetworkError(message = "network down") {
      queue.push(() => Promise.reject(new Error(message)));
    },
    enqueueHttpError(status, body = "") {
      queue.push(async () => new Response(body, { status }));
    },
    enqueueGraphQLErrors(errors, status = 200) {
      queue.push(
        async () =>
          new Response(JSON.stringify({ errors }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      );
    },
  };
}

export function installFetch(mockFetch: MockFetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch.fn;
  return () => {
    globalThis.fetch = original;
  };
}

/** Reset everything the auth surface keeps at module-level. */
export function resetAuthModuleState(): void {
  setAccessToken(null);
  setRefreshHandler(null);
  setLogoutHandler(null);
  __resetBootRefreshCacheForTest();
}

export function tokens<TRole extends string = string>(
  role: TRole,
  expiresIn = 3600,
  accessToken = "tk_" + role,
): TokenResponse<TRole> {
  return { access_token: accessToken, expires_in: expiresIn, role };
}

/** Flush microtasks. Use after kicking off an async path inside act(). */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
