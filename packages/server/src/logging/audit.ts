import type { Logger } from "pino";
import type { SessionContext } from "../utils/sessionVariables";

import { logger } from "./index";

export type AuditActor = {
  type: "admin_secret" | "console" | "token" | "credentials" | "anonymous";
  sub?: string;
  role?: string;
  ip?: string | undefined;
};

export type AuditEvent = {
  action: string;
  actor: AuditActor;
  target: Record<string, unknown>;
  outcome?: "success" | "failure";
  [key: string]: unknown;
};

export type AuditLog = {
  emit(event: AuditEvent): void;
};

const REDACTED_KEYS = new Set([
  "password",
  "secret",
  "secrets",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
]);

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      REDACTED_KEYS.has(key) ? "[REDACTED]" : redact(entry),
    ]),
  );
};

export const actorFromSession = (session: SessionContext | undefined): AuditActor => {
  if (!session) return { type: "anonymous" };
  const type =
    session.authMethod === "admin_secret" ? "admin_secret" : session.jti ? "token" : "anonymous";
  return {
    type,
    ...(session.sub !== undefined ? { sub: session.sub } : {}),
    ...(session.role !== undefined ? { role: session.role } : {}),
  };
};

export const createAuditLog = (base: Logger): AuditLog => {
  // An audit record has to survive LOG_LEVEL=warn: the level is pinned here,
  // independent of whatever the root logger was configured with.
  const log = base.child({});
  log.level = "info";

  return {
    emit: (event) => {
      log.info(redact(event) as object, event.action);
    },
  };
};

let override: AuditLog | null = null;
let instance: AuditLog | null = null;

/** Test seam: pass `null` to restore the default log. */
export const setAuditLog = (log: AuditLog | null): void => {
  override = log;
};

export const audit = (): AuditLog => {
  if (override) return override;
  if (!instance) instance = createAuditLog(logger("audit"));
  return instance;
};
