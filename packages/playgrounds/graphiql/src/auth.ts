const STORAGE_KEY = "graphiql_auth_token";
const TOKEN_KEYS = ["accessToken", "access_token", "token"];
const AUTH_OPERATION_KEYWORDS = ["login", "signin", "auth"];
const AUTH_QUERY_KEYWORDS = ["login", "signin"];
const LOGOUT_OPERATION_KEYWORDS = ["logout", "signout"];

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function getToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

export function setToken(token: string): void {
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
    notify("🔐 Token saved! It will be used for subsequent requests.");
  } else {
    localStorage.removeItem(STORAGE_KEY);
    notify("🔐 Token removed.");
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(message: string): void {
  for (const listener of listeners) listener(message);
}

function findTokenInResponse(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (TOKEN_KEYS.includes(key) && typeof child === "string") return child;
    if (child && typeof child === "object") {
      const found = findTokenInResponse(child);
      if (found) return found;
    }
  }
  return null;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function isAuthMutation(operationName: string, query: string): boolean {
  return (
    containsAny(operationName, AUTH_OPERATION_KEYWORDS) || containsAny(query, AUTH_QUERY_KEYWORDS)
  );
}

function isLogoutMutation(operationName: string): boolean {
  return containsAny(operationName, LOGOUT_OPERATION_KEYWORDS);
}

export function createAuthFetch(): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    const token = getToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(input, { ...init, headers });

    try {
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      if (!bodyRaw) return response;
      const body = JSON.parse(bodyRaw);
      const operationName = (body.operationName ?? "").toLowerCase();
      const query = (body.query ?? "").toLowerCase();

      if (isLogoutMutation(operationName)) {
        setToken("");
      } else if (isAuthMutation(operationName, query)) {
        const result = await response.clone().json();
        const found = findTokenInResponse(result?.data);
        if (found) setToken(found);
      }
    } catch {
      // Non-JSON request bodies or responses are ignored, matching offline behavior.
    }

    return response;
  };
}
