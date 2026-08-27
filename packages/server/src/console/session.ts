import { timingSafeEqual } from "crypto";

import type { BunRequest } from "bun";
import type { TokenService } from "../authentication/types";
import type { Env } from "../types/env";

import { parseDurationToMs, parseDurationToSeconds } from "../authentication/duration";
import { logger } from "../logging";

export const CONSOLE_SESSION_COOKIE = "graphoria_console_session";

// Separates a console session from an access or refresh token signed with the
// same key: neither can be presented where the other is expected.
const CONSOLE_AUDIENCE = "console";
const CONSOLE_SUBJECT = "console";

const safeCompare = (a: string, b: string): boolean => {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
};

export type ConsoleSessions = {
  /** Exchange the admin secret for a session cookie. Throws if it does not match. */
  login(req: BunRequest): Promise<{ expiresIn: number }>;
  /** True when the request carries a live, unrevoked console session cookie. */
  authorize(req: BunRequest): Promise<boolean>;
  logout(req: BunRequest): Promise<void>;
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
      return payload;
    } catch {
      return null;
    }
  };

  return {
    login: async (req) => {
      const { secret: submitted } = (await req.json()) as { secret?: string };

      if (!env.admin.secret || !submitted || !safeCompare(submitted, env.admin.secret)) {
        throw new Error("Invalid admin secret");
      }

      const token = await tokenService.createToken(
        { sub: CONSOLE_SUBJECT, role: env.superadmin.role },
        { audience: CONSOLE_AUDIENCE, expiresIn },
      );

      req.cookies.set(CONSOLE_SESSION_COOKIE, token, {
        ...cookieOptions,
        maxAge: parseDurationToSeconds(expiresIn),
      });

      log.info("console session issued");

      return { expiresIn: parseDurationToSeconds(expiresIn) };
    },

    authorize: async (req) => {
      const payload = await readSession(req);
      if (!payload) return false;

      prune();
      return !revoked.has(payload.jti);
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
    },
  };
};
