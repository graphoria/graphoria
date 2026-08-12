const SECRET_KEY = "graphoria_console_secret";

// Under hash routing the pathname is always the console mount path.
export const apiBase = `${location.pathname.replace(/\/+$/, "")}/api`;

export type Meta = { name: string; version: string; adminSecretHeader: string };

export type TablesResponse = {
  tables: {
    schema: string;
    name: string;
    entityType: string;
    resolverName: string;
    description: string | null;
    columns: {
      name: string;
      dataType?: string;
      isNullable?: boolean;
      description?: string | null;
    }[];
    relationships: {
      schema: string;
      name: string;
      columns: {
        source: string;
        target: string;
      }[];
    }[];
  }[];
};

export type PermissionValue =
  | "ALL"
  | string[]
  | Record<string, "ALL" | { columns?: "ALL" | string[]; filter?: unknown; orderBy?: unknown }>;

export type RolesResponse = {
  roles: string[];
  permissions: Record<string, Record<string, PermissionValue>>;
};

export type StatusResponse = {
  uptimeSeconds: number;
  tokenStrategy: string;
  memoryRssBytes: number;
  bunVersion: string;
  pid: number;
  databases: { name: string; type: string; connected: boolean; latencyMs: number | null }[];
  publishers: string[];
  subscribers: { name: string; topic: string }[];
  queueConnections: { type: string; connected: boolean }[];
  cron: {
    name: string;
    pattern: string;
    executionCount: number;
    isRunning: boolean;
    isBusy: boolean;
    nextRun: string | null;
  }[];
};

export type ApisResponse = {
  operations: { name: string; method: string; path: string; tag: string }[];
  remoteREST: { name: string; prefix: string; baseUrl: string; routes: number }[];
  remoteSchemas: {
    name: string;
    prefix: string;
    url: string;
    queryFields: number;
    mutationFields: number;
  }[];
};

export type SchemaResponse = { role: string; sdl: string };

export type ConfigResponse = {
  name: string;
  version: string;
  prefixes: Record<string, string>;
  features: Record<string, boolean>;
};

export type RoleEntitiesResponse = {
  role: string;
  tables: { schema: string; name: string; columns: string[] }[];
  operations: { name: string; method: string | null; path: string | null }[];
  remoteSchemas: { name: string; prefix: string; queryFields: number; mutationFields: number }[];
  remoteREST: { name: string; prefix: string; routes: number }[];
};

export const getSecret = () => localStorage.getItem(SECRET_KEY);
export const setSecret = (secret: string) => localStorage.setItem(SECRET_KEY, secret);
export const clearSecret = () => localStorage.removeItem(SECRET_KEY);

export class AuthError extends Error {}

let adminHeaderName = "x-admin-secret";
let authFailHandler: () => void = () => {};

export const setAdminHeaderName = (name: string) => {
  adminHeaderName = name;
};

export const onAuthFail = (handler: () => void) => {
  authFailHandler = handler;
};

export const getMeta = async (): Promise<Meta> => {
  const res = await fetch(`${apiBase}/meta`);
  if (!res.ok) throw new Error(`meta request failed (${res.status})`);
  return res.json();
};

export const apiFetch = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { [adminHeaderName]: getSecret() ?? "" },
  });

  // The server gate answers 404 for any non-superadmin session
  if (res.status === 404) {
    authFailHandler();
    throw new AuthError("Invalid admin secret");
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`);

  return res.json();
};

export const apiPost = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { [adminHeaderName]: getSecret() ?? "", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 404) {
    authFailHandler();
    throw new AuthError("Invalid admin secret");
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      errors?: { message?: string }[];
    } | null;
    throw new Error(payload?.errors?.[0]?.message ?? `Request failed (${res.status})`);
  }

  return res.json();
};
