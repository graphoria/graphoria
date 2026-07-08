import { describe, expect, it } from "bun:test";

import type { TokenRepository } from "./tokenRepository";

import { EnvZod } from "../types/env";
import { createJWTService } from "./jwt";

const createFakeRepo = (): TokenRepository => {
  const revoked = new Set<string>();
  const used = new Set<string>();
  return {
    saveJti: async (jti) => {
      used.add(jti);
    },
    isTokenUsed: async (jti) => used.has(jti),
    revoke: async (jti) => {
      revoked.add(jti);
    },
    isRevoked: async (jti) => revoked.has(jti),
  };
};

const adminSecret = "admin-secret";
const anonymousRole = "anonymous";

const envMock = EnvZod.parse({
  ADMIN_SECRET: adminSecret,
  ANONYMOUS_ROLE: anonymousRole,
  JWT_SECRET: "test-secret",
  CONFIGURATION_PATH: "./configuration.json",
});

const service = createJWTService(envMock);

describe("JWT Service", () => {
  it("createTokenPair and verifyToken", async () => {
    const payload = { sub: "user1", role: "user" };

    const pair = await service.createTokenPair(payload);

    expect(pair.access_token).toBeString();
    expect(pair.expires_in).toBe(300); // 5m default = 300 seconds

    if (!pair.access_token) return;

    const { access_token, refresh_token } = pair;
    expect(typeof access_token).toBe("string");
    expect(typeof refresh_token).toBe("string");

    // Verify access token with correct audience
    const verified = await service.verifyToken(access_token, {
      audience: "access",
    });
    expect(verified.sub).toBe(payload.sub);
    expect(verified.role).toBe(payload.role);
    expect(verified.jti).toBeDefined();

    // Verify refresh token has different audience
    const verifiedRefresh = await service.verifyToken(refresh_token, {
      audience: "refresh",
    });
    expect(verifiedRefresh.sub).toBe(payload.sub);
    expect(verifiedRefresh.role).toBe(payload.role);
  });

  it("should reject refresh token used as access token", async () => {
    const payload = { sub: "user1", role: "user" };
    const pair = await service.createTokenPair(payload);

    // Using refresh token with access audience should fail
    await expect(service.verifyToken(pair.refresh_token, { audience: "access" })).rejects.toThrow();
  });

  it("verifyTokenAndGetRole with no header", async () => {
    const role = await service.verifyTokenAndGetRole(null, null);

    expect(role).toBe(anonymousRole);
  });

  it("verifyTokenAndGetRole with invalid header", async () => {
    const role = await service.verifyTokenAndGetRole("Bearer invalid", null);

    expect(role).toBe(anonymousRole);
  });

  it("verifyTokenAndGetRole with valid access_token", async () => {
    const token = await service.createTokenPair({
      sub: "u",
      role: "r",
    });

    expect(token.access_token).toBeString();

    if (!token.access_token) return;

    const role = await service.verifyTokenAndGetRole(`Bearer ${token.access_token}`, null);

    expect(role).toBe("r");
  });

  it("verifyTokenAndGetRole with admin secret", async () => {
    const role = await service.verifyTokenAndGetRole(null, adminSecret);

    expect(role).toBe("superadmin");
  });

  it("revoked access token returns anonymous from verifyTokenAndGetSession", async () => {
    const repo = createFakeRepo();
    const svc = createJWTService(envMock, repo);
    const pair = await svc.createTokenPair({ sub: "u", role: "r" });

    const beforeRevoke = await svc.verifyTokenAndGetSession(`Bearer ${pair.access_token}`, null);
    expect(beforeRevoke.role).toBe("r");

    await svc.revoke(beforeRevoke.jti!);

    const afterRevoke = await svc.verifyTokenAndGetSession(`Bearer ${pair.access_token}`, null);
    expect(afterRevoke.sub).toBe("anonymous");
    expect(afterRevoke.role).toBe(anonymousRole);
  });

  it("refreshAccessToken rejects revoked refresh token", async () => {
    const repo = createFakeRepo();
    const svc = createJWTService(envMock, repo);
    const pair = await svc.createTokenPair({ sub: "u", role: "r" });

    const refreshPayload = await svc.verifyToken(pair.refresh_token, {
      audience: "refresh",
    });
    await svc.revoke(refreshPayload.jti);

    await expect(svc.refreshAccessToken(pair.refresh_token)).rejects.toThrow("Token revoked");
  });
});
