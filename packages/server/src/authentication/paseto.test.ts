import { describe, expect, it } from "bun:test";
import { generateKeys } from "paseto-ts/v4";

import type { TokenRepository } from "./tokenRepository";

import { EnvZod } from "../types/env";
import { createPASETOService } from "./paseto";

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

// Generate keys for testing
const localKey = generateKeys("local") as string;
const { secretKey, publicKey } = generateKeys("public") as {
  secretKey: string;
  publicKey: string;
};

const baseEnv = {
  ADMIN_SECRET: adminSecret,
  ANONYMOUS_ROLE: anonymousRole,
  JWT_SECRET: "unused-for-paseto",
};

describe("PASETO Service - v4.local", () => {
  const envMock = EnvZod.parse({
    ...baseEnv,
    PASETO_LOCAL_KEY: localKey,
  });

  const service = createPASETOService(envMock, "local");

  it("createTokenPair and verifyToken", async () => {
    const payload = { sub: "user1", role: "user" };

    const pair = await service.createTokenPair(payload);

    expect(pair.access_token).toBeString();
    expect(pair.access_token).toStartWith("v4.local.");
    expect(pair.expires_in).toBe(300); // 5m default

    const verified = await service.verifyToken(pair.access_token, {
      audience: "access",
    });
    expect(verified.sub).toBe(payload.sub);
    expect(verified.role).toBe(payload.role);
    expect(verified.jti).toBeDefined();

    const verifiedRefresh = await service.verifyToken(pair.refresh_token, {
      audience: "refresh",
    });
    expect(verifiedRefresh.sub).toBe(payload.sub);
    expect(verifiedRefresh.role).toBe(payload.role);
  });

  it("should reject refresh token used as access token", async () => {
    const payload = { sub: "user1", role: "user" };
    const pair = await service.createTokenPair(payload);

    await expect(service.verifyToken(pair.refresh_token, { audience: "access" })).rejects.toThrow(
      "Audience mismatch",
    );
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
    const pair = await service.createTokenPair({ sub: "u", role: "r" });

    const role = await service.verifyTokenAndGetRole(`Bearer ${pair.access_token}`, null);
    expect(role).toBe("r");
  });

  it("verifyTokenAndGetRole with admin secret", async () => {
    const role = await service.verifyTokenAndGetRole(null, adminSecret);
    expect(role).toBe("superadmin");
  });

  it("verifyTokenAndGetSession returns full session context", async () => {
    const svc = createPASETOService(envMock, "local", createFakeRepo());
    const pair = await svc.createTokenPair({
      sub: "user1",
      role: "admin",
      claims: { orgId: "org-123" },
    });

    const session = await svc.verifyTokenAndGetSession(`Bearer ${pair.access_token}`, null);

    expect(session.sub).toBe("user1");
    expect(session.role).toBe("admin");
    expect(session.jti).toBeDefined();
    expect(session.claims).toEqual({ orgId: "org-123" });
    expect(typeof session.iat).toBe("number");
    expect(typeof session.exp).toBe("number");
  });

  it("verifyTokenAndGetSession with admin secret", async () => {
    const session = await service.verifyTokenAndGetSession(null, adminSecret);
    expect(session.sub).toBe("superadmin");
    expect(session.role).toBe("superadmin");
  });

  it("verifyTokenAndGetSession with no header returns anonymous", async () => {
    const session = await service.verifyTokenAndGetSession(null, null);
    expect(session.sub).toBe("anonymous");
    expect(session.role).toBe(anonymousRole);
  });

  it("revoked access token returns anonymous from verifyTokenAndGetSession", async () => {
    const repo = createFakeRepo();
    const svc = createPASETOService(envMock, "local", repo);
    const pair = await svc.createTokenPair({ sub: "u", role: "r" });

    const before = await svc.verifyTokenAndGetSession(`Bearer ${pair.access_token}`, null);
    expect(before.role).toBe("r");

    await svc.revoke(before.jti!);

    const after = await svc.verifyTokenAndGetSession(`Bearer ${pair.access_token}`, null);
    expect(after.sub).toBe("anonymous");
    expect(after.role).toBe(anonymousRole);
  });

  it("refreshAccessToken rejects revoked refresh token", async () => {
    const repo = createFakeRepo();
    const svc = createPASETOService(envMock, "local", repo);
    const pair = await svc.createTokenPair({ sub: "u", role: "r" });

    const refreshPayload = await svc.verifyToken(pair.refresh_token, {
      audience: "refresh",
    });
    await svc.revoke(refreshPayload.jti);

    await expect(svc.refreshAccessToken(pair.refresh_token)).rejects.toThrow("Token revoked");
  });
});

describe("PASETO Service - v4.public", () => {
  const envMock = EnvZod.parse({
    ...baseEnv,
    PASETO_SECRET_KEY: secretKey,
    PASETO_PUBLIC_KEY: publicKey,
  });

  const service = createPASETOService(envMock, "public");

  it("createTokenPair and verifyToken", async () => {
    const payload = { sub: "user1", role: "user" };

    const pair = await service.createTokenPair(payload);

    expect(pair.access_token).toBeString();
    expect(pair.access_token).toStartWith("v4.public.");
    expect(pair.expires_in).toBe(300);

    const verified = await service.verifyToken(pair.access_token, {
      audience: "access",
    });
    expect(verified.sub).toBe(payload.sub);
    expect(verified.role).toBe(payload.role);
    expect(verified.jti).toBeDefined();

    const verifiedRefresh = await service.verifyToken(pair.refresh_token, {
      audience: "refresh",
    });
    expect(verifiedRefresh.sub).toBe(payload.sub);
    expect(verifiedRefresh.role).toBe(payload.role);
  });

  it("should reject refresh token used as access token", async () => {
    const payload = { sub: "user1", role: "user" };
    const pair = await service.createTokenPair(payload);

    await expect(service.verifyToken(pair.refresh_token, { audience: "access" })).rejects.toThrow(
      "Audience mismatch",
    );
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
    const pair = await service.createTokenPair({ sub: "u", role: "r" });

    const role = await service.verifyTokenAndGetRole(`Bearer ${pair.access_token}`, null);
    expect(role).toBe("r");
  });

  it("verifyTokenAndGetRole with admin secret", async () => {
    const role = await service.verifyTokenAndGetRole(null, adminSecret);
    expect(role).toBe("superadmin");
  });

  it("verifyTokenAndGetSession returns full session context", async () => {
    const svc = createPASETOService(envMock, "public", createFakeRepo());
    const pair = await svc.createTokenPair({
      sub: "user1",
      role: "admin",
      claims: { orgId: "org-123" },
    });

    const session = await svc.verifyTokenAndGetSession(`Bearer ${pair.access_token}`, null);

    expect(session.sub).toBe("user1");
    expect(session.role).toBe("admin");
    expect(session.jti).toBeDefined();
    expect(session.claims).toEqual({ orgId: "org-123" });
    expect(typeof session.iat).toBe("number");
    expect(typeof session.exp).toBe("number");
  });
});
