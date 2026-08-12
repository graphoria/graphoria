// ============================================================================
// Token Store - framework-agnostic, module-level state.
//
// User's GraphQL client (Apollo/urql/relay/anything) integrates via:
//   - getAccessToken() in its auth middleware
//   - subscribeAccessToken() to react to changes (e.g. restart WS)
//   - ensureFreshToken() from its 401 error handler
// AuthProvider wires the actual refresh/logout implementations via
// setRefreshHandler / setLogoutHandler at mount time.
// ============================================================================

type RefreshHandler = () => Promise<boolean>;
type LogoutHandler = () => Promise<void> | void;
type Listener = (token: string | null) => void;

let inMemoryAccessToken: string | null = null;
let refreshHandler: RefreshHandler | null = null;
let logoutHandler: LogoutHandler | null = null;
let inflightRefresh: Promise<boolean> | null = null;
const listeners: Set<Listener> = new Set();

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function setAccessToken(token: string | null): void {
  if (inMemoryAccessToken === token) return;
  inMemoryAccessToken = token;
  for (const cb of listeners) cb(token);
}

/** Subscribe to token changes. Returns unsubscribe fn. */
export function subscribeAccessToken(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setRefreshHandler(fn: RefreshHandler | null): void {
  refreshHandler = fn;
}

export function setLogoutHandler(fn: LogoutHandler | null): void {
  logoutHandler = fn;
}

/**
 * Single-flight token refresh. Call from any GraphQL client's 401 handler.
 * Concurrent calls share one in-flight refresh. On failure, triggers logout.
 */
export function ensureFreshToken(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh;
  if (!refreshHandler) return Promise.resolve(false);

  inflightRefresh = refreshHandler()
    .then((ok) => {
      if (!ok && logoutHandler) {
        void logoutHandler();
      }
      return ok;
    })
    .catch(() => {
      if (logoutHandler) void logoutHandler();
      return false;
    })
    .finally(() => {
      inflightRefresh = null;
    });

  return inflightRefresh;
}
