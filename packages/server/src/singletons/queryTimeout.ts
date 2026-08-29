/**
 * The process-wide statement timeout in milliseconds, resolved from
 * `QUERY_TIMEOUT_MS` at boot.
 *
 * It lives here rather than being read from `singletons/env` because the engine
 * connection modules need it, and that module parses `process.env` the moment it
 * is imported — reaching it from an engine would make every unit test that
 * transitively touches a query builder fail without `ADMIN_SECRET` set.
 *
 * `0` disables the bound. That is also the value before boot sets it, so an
 * engine used outside a booted server behaves exactly as it did before timeouts
 * existed.
 */
let queryTimeoutMs = 0;

export const setQueryTimeoutMs = (ms: number) => {
  queryTimeoutMs = ms;
};

export const getQueryTimeoutMs = () => queryTimeoutMs;
