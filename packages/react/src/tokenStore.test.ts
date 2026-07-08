import { beforeEach, describe, expect, it, mock } from "bun:test";

import {
  ensureFreshToken,
  getAccessToken,
  setAccessToken,
  setLogoutHandler,
  setRefreshHandler,
  subscribeAccessToken,
} from "./tokenStore";
import { resetAuthModuleState } from "./__test/helpers";

describe("tokenStore", () => {
  beforeEach(() => {
    resetAuthModuleState();
  });

  describe("storage + broadcast", () => {
    it("getAccessToken returns null initially and the set value after setAccessToken", () => {
      expect(getAccessToken()).toBeNull();
      setAccessToken("abc");
      expect(getAccessToken()).toBe("abc");
    });

    it("subscribeAccessToken fires on change; unsubscribe stops further notifications", () => {
      const cb = mock();
      const unsubscribe = subscribeAccessToken(cb);

      setAccessToken("first");
      setAccessToken("second");
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenLastCalledWith("second");

      unsubscribe();
      setAccessToken("third");
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it("setting the same token is a no-op (listeners not called)", () => {
      setAccessToken("same");
      const cb = mock();
      const unsubscribe = subscribeAccessToken(cb);

      setAccessToken("same");
      expect(cb).not.toHaveBeenCalled();

      setAccessToken("changed");
      expect(cb).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("multiple subscribers all receive each change", () => {
      const a = mock();
      const b = mock();
      const ua = subscribeAccessToken(a);
      const ub = subscribeAccessToken(b);

      setAccessToken("x");
      expect(a).toHaveBeenCalledWith("x");
      expect(b).toHaveBeenCalledWith("x");
      ua();
      ub();
    });
  });

  describe("ensureFreshToken (single-flight)", () => {
    it("resolves false immediately when no refresh handler is set", async () => {
      const result = await ensureFreshToken();
      expect(result).toBe(false);
    });

    it("two concurrent calls share one in-flight handler invocation", async () => {
      let resolve!: (ok: boolean) => void;
      const handler = mock(
        () =>
          new Promise<boolean>((r) => {
            resolve = r;
          }),
      );
      setRefreshHandler(handler);

      const p1 = ensureFreshToken();
      const p2 = ensureFreshToken();
      expect(handler).toHaveBeenCalledTimes(1);

      resolve(true);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
    });

    it("handler returns false → invokes logoutHandler once", async () => {
      const logout = mock();
      setRefreshHandler(async () => false);
      setLogoutHandler(logout);

      const ok = await ensureFreshToken();
      expect(ok).toBe(false);
      expect(logout).toHaveBeenCalledTimes(1);
    });

    it("handler throws → invokes logoutHandler and resolves false", async () => {
      const logout = mock();
      setRefreshHandler(async () => {
        throw new Error("boom");
      });
      setLogoutHandler(logout);

      const ok = await ensureFreshToken();
      expect(ok).toBe(false);
      expect(logout).toHaveBeenCalledTimes(1);
    });

    it("inflight cleared after settle (next call invokes handler again)", async () => {
      const handler = mock(async () => true);
      setRefreshHandler(handler);

      await ensureFreshToken();
      await ensureFreshToken();
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("success path does not call logout handler", async () => {
      const logout = mock();
      setRefreshHandler(async () => true);
      setLogoutHandler(logout);

      const ok = await ensureFreshToken();
      expect(ok).toBe(true);
      expect(logout).not.toHaveBeenCalled();
    });
  });
});
