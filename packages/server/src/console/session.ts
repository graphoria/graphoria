import type { BunRequest } from "bun";
import type { TokenService } from "../authentication/types";
import type { Env } from "../types/env";

import { createCapabilityAuthorizer } from "../authentication/capabilities";
import { parseDurationToMs, parseDurationToSeconds } from "../authentication/duration";
import { logger } from "../logging";

export const CONSOLE_SESSION_COOKIE = "graphoria_console_session";

// Separates a console session from an access or refresh token signed with the
// same key: neither can be presented where the other is expected.
const CONSOLE_AUDIENCE = "console";
const CONSOLE_SUBJECT = "console";

/** `read` sees state; `write` may also publish to queues and control cron. */
export type ConsoleScope = "read" | "write";

const isScope = (value: unknown): value is ConsoleScope => value === "read" || value === "write";

export type ConsoleSessions = {
  /**
   * Exchange a secret for a session cookie. Throws if none matches. `superset`
   * is true when it was the admin secret rather than a console credential.
   */
  login(req: BunRequest): Promise<{ expiresIn: number; scope: ConsoleScope; superset: boolean }>;
  /** The scope of a live, unrevoked console session cookie; null when there is none. */
  authorize(req: BunRequest): Promise<ConsoleScope | null>;
  /** Resolves true when a live session was revoked; the cookie is cleared either way. */
  logout(req: BunRequest): Promise<boolean>;
};

type ConsoleSessionsOptions = {
  env: Env;
  consolePath: string;
  tokenService: TokenService;
};

export const createConsoleSessions = ({
  env,
  consolePath,
  tokenService,
}: ConsoleSessionsOptions): ConsoleSessions => {
  const log = logger("console");
  const authorizeCapability = createCapabilityAuthorizer(env);
  const expiresIn = env.console.sessionExpiresIn;
  const sessionMs = parseDurationToMs(expiresIn);

  // Revoked JTIs, held in this process only: the console mints its own tokens
  // and never writes to the Redis JTI store, so a logout is honoured by the
  // worker that served it and by no other. An entry is dropped once the token
  // it revokes would have expired on its own.
  const revoked = new Map<string, number>();

  const prune = () => {
    const now = Date.now();
    for (const [jti, expiresAt] of revoked) if (expiresAt <= now) revoked.delete(jti);
  };

  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: consolePath,
  } as const;

  const readSession = async (req: BunRequest) => {
    const cookie = req.cookies?.get(CONSOLE_SESSION_COOKIE);
    if (!cookie) return null;

    try {
      const payload = await tokenService.verifyToken(cookie, { audience: CONSOLE_AUDIENCE });
      if (payload.role !== env.superadmin.role) return null;
      const scope = payload.claims?.scope;
      if (!isScope(scope)) return null;
      return { ...payload, scope };
    } catch {
      return null;
    }
  };

  return {
    login: async (req) => {
      const { secret: submitted } = (await req.json()) as { secret?: string };

      const candidate = submitted ?? null;
      const write = authorizeCapability(candidate, "console:write");
      const grant = write ?? authorizeCapability(candidate, "console:read");
      if (!grant) throw new Error("Invalid admin secret");
      const scope: ConsoleScope = write ? "write" : "read";

      const token = await tokenService.createToken(
        { sub: CONSOLE_SUBJECT, role: env.superadmin.role, claims: { scope } },
        { audience: CONSOLE_AUDIENCE, expiresIn },
      );

      req.cookies.set(CONSOLE_SESSION_COOKIE, token, {
        ...cookieOptions,
        maxAge: parseDurationToSeconds(expiresIn),
      });

      log.info({ scope }, "console session issued");

      return { expiresIn: parseDurationToSeconds(expiresIn), scope, superset: grant.superset };
    },

    authorize: async (req) => {
      const payload = await readSession(req);
      if (!payload) return null;

      prune();
      return revoked.has(payload.jti) ? null : payload.scope;
    },

    logout: async (req) => {
      const payload = await readSession(req);
      if (payload) {
        // The token stays valid until it expires, so the revocation record has
        // to outlive it: one full session lifetime is the upper bound.
        revoked.set(payload.jti, Date.now() + sessionMs);
        log.info("console session revoked");
      }

      req.cookies.delete({ name: CONSOLE_SESSION_COOKIE, path: consolePath });

      return payload !== null;
    },
  };
};
