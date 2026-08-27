import { CookieMap } from "bun";
import { beforeEach, describe, expect, it } from "bun:test";

import type { BunRequest } from "bun";
import type { TokenRepository } from "../authentication/tokenRepository";
import type { Env } from "../types/env";

import { CONSOLE_SESSION_COOKIE, createConsoleSessions } from "./session";
import { createJWTService } from "../authentication/jwt";

const ADMIN_SECRET = "console-admin-secret";
const CONSOLE_PATH = "/_console";

const noopRepository: TokenRepository = {
  saveJti: async () => {},
  isTokenUsed: async () => false,
  revoke: async () => {},
  isRevoked: async () => false,
};

const buildEnv = (sessionExpiresIn = "1h") =>
  ({
    admin: { secret: ADMIN_SECRET, header: "x-admin-secret" },
    anonymousRole: "anonymous",
    superadmin: { role: "superadmin" },
    console: { enabled: true, endpoint: CONSOLE_PATH, sessionExpiresIn },
    jwt: { secret: "console-jwt-secret", expiresIn: "5m", rtExpiresIn: "7d" },
    cache: { store: "memory", redisUrl: "redis://127.0.0.1:1" },
  }) as unknown as Env;

const request = (cookie = "", body?: unknown) => {
  const req = new Request("http://localhost/_console/api/login", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as BunRequest;
  Object.defineProperty(req, "cookies", { value: new CookieMap(cookie), writable: false });
  return req;
};

const setCookieOf = (req: BunRequest) => req.cookies.toSetCookieHeaders()[0] ?? "";

const sessionCookieOf = (req: BunRequest) =>
  `${CONSOLE_SESSION_COOKIE}=${req.cookies.get(CONSOLE_SESSION_COOKIE)}`;

describe("createConsoleSessions", () => {
  let env: Env;
  let tokenService: ReturnType<typeof createJWTService>;
  let sessions: ReturnType<typeof createConsoleSessions>;

  beforeEach(() => {
    env = buildEnv();
    tokenService = createJWTService(env, noopRepository);
    sessions = createConsoleSessions({ env, consolePath: CONSOLE_PATH, tokenService });
  });

  it("rejects a wrong admin secret", async () => {
    const req = request("", { secret: "wrong" });
    expect(sessions.login(req)).rejects.toThrow("Invalid admin secret");
    expect(setCookieOf(req)).toBe("");
  });

  it("rejects a request with no secret at all", async () => {
    expect(sessions.login(request("", {}))).rejects.toThrow("Invalid admin secret");
  });

  it("issues an httpOnly, Secure, SameSite=Strict cookie scoped to the console path", async () => {
    const req = request("", { secret: ADMIN_SECRET });
    const { expiresIn } = await sessions.login(req);

    expect(expiresIn).toBe(3600);

    const setCookie = setCookieOf(req);
    expect(setCookie).toStartWith(`${CONSOLE_SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain(`Path=${CONSOLE_PATH}`);
    expect(setCookie).toContain("Max-Age=3600");
  });

  it("never puts the admin secret in the cookie", async () => {
    const req = request("", { secret: ADMIN_SECRET });
    await sessions.login(req);
    expect(setCookieOf(req)).not.toContain(ADMIN_SECRET);
  });

  it("authorizes the cookie it just issued", async () => {
    const login = request("", { secret: ADMIN_SECRET });
    await sessions.login(login);

    expect(await sessions.authorize(request(sessionCookieOf(login)))).toBe(true);
  });

  it("refuses a request with no cookie", async () => {
    expect(await sessions.authorize(request())).toBe(false);
  });

  it("refuses a forged cookie", async () => {
    expect(await sessions.authorize(request(`${CONSOLE_SESSION_COOKIE}=not-a-token`))).toBe(false);
  });

  it("refuses an access token presented as a console session", async () => {
    const { access_token } = await tokenService.createTokenPair({
      sub: "alice",
      role: "superadmin",
    });

    expect(await sessions.authorize(request(`${CONSOLE_SESSION_COOKIE}=${access_token}`))).toBe(
      false,
    );
  });

  it("refuses a console token minted for a non-superadmin role", async () => {
    const token = await tokenService.createToken(
      { sub: "console", role: "user" },
      { audience: "console" },
    );

    expect(await sessions.authorize(request(`${CONSOLE_SESSION_COOKIE}=${token}`))).toBe(false);
  });

  it("refuses an expired session", async () => {
    env = buildEnv("-1s");
    tokenService = createJWTService(env, noopRepository);
    sessions = createConsoleSessions({ env, consolePath: CONSOLE_PATH, tokenService });

    const login = request("", { secret: ADMIN_SECRET });
    await sessions.login(login);

    expect(await sessions.authorize(request(sessionCookieOf(login)))).toBe(false);
  });

  it("revokes the session on logout, so the same cookie stops working", async () => {
    const login = request("", { secret: ADMIN_SECRET });
    await sessions.login(login);
    const cookie = sessionCookieOf(login);

    expect(await sessions.authorize(request(cookie))).toBe(true);

    await sessions.logout(request(cookie));

    expect(await sessions.authorize(request(cookie))).toBe(false);
  });

  it("clears the cookie on the console path on logout", async () => {
    const req = request(`${CONSOLE_SESSION_COOKIE}=whatever`);
    await sessions.logout(req);

    const setCookie = setCookieOf(req);
    expect(setCookie).toStartWith(`${CONSOLE_SESSION_COOKIE}=;`);
    expect(setCookie).toContain(`Path=${CONSOLE_PATH}`);
  });

  it("logging out one session leaves another alive", async () => {
    const first = request("", { secret: ADMIN_SECRET });
    await sessions.login(first);
    const second = request("", { secret: ADMIN_SECRET });
    await sessions.login(second);

    await sessions.logout(request(sessionCookieOf(first)));

    expect(await sessions.authorize(request(sessionCookieOf(first)))).toBe(false);
    expect(await sessions.authorize(request(sessionCookieOf(second)))).toBe(true);
  });

  it("logout without a cookie is a no-op", async () => {
    expect(sessions.logout(request())).resolves.toBeUndefined();
  });
});
