const STORAGE_KEY = "scalar_auth_token";
const TOKEN_SAVED_MESSAGE = "🔐 Token saved! It will be used for subsequent requests.";
const TOKEN_REMOVED_MESSAGE = "🔐 Token removed.";

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function getToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

export function setToken(token: string): void {
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
    notify(TOKEN_SAVED_MESSAGE);
  } else {
    localStorage.removeItem(STORAGE_KEY);
    notify(TOKEN_REMOVED_MESSAGE);
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(message: string): void {
  for (const listener of listeners) listener(message);
}

const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);

  try {
    const prefix = window.__REST_PREFIX__;
    if (!prefix) return response;

    const input = args[0];
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as Request)?.url ?? "");

    if (url.endsWith(prefix + "/auth/login") || url.endsWith(prefix + "/auth/refresh")) {
      const data = await response.clone().json();
      const token = data?.data?.access_token;
      if (token) setToken(token);
    } else if (url.endsWith(prefix + "/auth/logout")) {
      setToken("");
    }
  } catch {
    // Non-JSON responses or parse errors are ignored, matching scalar.html behavior.
  }

  return response;
};
