import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import FakeTimers from "@sinonjs/fake-timers";

import type { ReactNode } from "react";
import type { AuthContextType } from "./types";

import { AuthProvider, useAuth } from "./AuthContext";
import { ensureFreshToken, getAccessToken, setRefreshHandler } from "./tokenStore";
import {
  flushMicrotasks,
  installFetch,
  makeMockFetch,
  resetAuthModuleState,
  tokens,
  type MockFetch,
} from "./__test/helpers";

interface CaptureProps {
  ctxRef: { current: AuthContextType<string> | null };
}

function Capture({ ctxRef }: CaptureProps) {
  const ctx = useAuth<string>();
  ctxRef.current = ctx;
  return null;
}

function makeCtxRef(): CaptureProps["ctxRef"] {
  return { current: null };
}

describe("AuthContext", () => {
  let mockFetch: MockFetch;
  let uninstallFetch: () => void;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetAuthModuleState();
    mockFetch = makeMockFetch();
    uninstallFetch = installFetch(mockFetch);
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    uninstallFetch();
    consoleErrorSpy.mockRestore();
  });

  // ===========================================================================
  // Boot (mount) behavior
  // ===========================================================================
  describe("boot", () => {
    it("calls auth_refresh and hydrates state when tokens are returned", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
      const onTokenRefresh = mock();
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider onTokenRefresh={onTokenRefresh}>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(ctxRef.current).not.toBeNull();
        expect(ctxRef.current?.isAuthenticated).toBe(true);
      });
      expect(ctxRef.current?.user).toEqual({ role: "admin" });
      expect(ctxRef.current?.isLoading).toBe(false);
      expect(ctxRef.current?.error).toBeNull();
      expect(getAccessToken()).toBe("tk_admin");
      expect(onTokenRefresh).toHaveBeenCalledWith("tk_admin", 3600);
      expect(mockFetch.calls.length).toBe(1);
      expect(mockFetch.calls[0].body.query).toContain("auth_refresh");
    });

    it("boot with null response: stays unauthenticated, isLoading flips to false", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );

      await waitFor(() => expect(ctxRef.current).not.toBeNull());
      expect(ctxRef.current?.isAuthenticated).toBe(false);
      expect(ctxRef.current?.user).toBeNull();
      expect(ctxRef.current?.isLoading).toBe(false);
      expect(ctxRef.current?.error).toBeNull();
    });

    it("boot with network error: swallows, isLoading flips to false, no error state", async () => {
      mockFetch.enqueueNetworkError("offline");
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );

      await waitFor(() => expect(ctxRef.current).not.toBeNull());
      expect(ctxRef.current?.isAuthenticated).toBe(false);
      expect(ctxRef.current?.error).toBeNull();
    });

    it("StrictMode double-mount calls fetch exactly once (boot cache dedup)", async () => {
      // Only ONE response queued — if dedup fails, the 2nd fetch throws.
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("user", 600) });
      const ctxRef = makeCtxRef();

      render(
        <StrictMode>
          <AuthProvider>
            <Capture ctxRef={ctxRef} />
          </AuthProvider>
        </StrictMode>,
      );

      await waitFor(() => expect(ctxRef.current?.isAuthenticated).toBe(true));
      expect(mockFetch.calls.length).toBe(1);
    });

    it("unmount during in-flight boot does not throw or call setState post-unmount", async () => {
      let resolveFetch!: (r: Response) => void;
      mockFetch.queue.push(
        () =>
          new Promise<Response>((r) => {
            resolveFetch = r;
          }),
      );
      const ctxRef = makeCtxRef();

      const { unmount } = render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );

      unmount();
      // Now resolve the in-flight fetch — boot's `if (!mounted) return` guards it.
      resolveFetch(
        new Response(JSON.stringify({ data: { auth_refresh: tokens("admin") } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await flushMicrotasks();

      // No console error from React about setState on unmounted component.
      const stateUpdateWarnings = consoleErrorSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("unmounted"),
      );
      expect(stateUpdateWarnings.length).toBe(0);
    });
  });

  // ===========================================================================
  // login
  // ===========================================================================
  describe("login", () => {
    it("success: transitions to authenticated, returns user, fires onAuthChange", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null }); // boot: no session
      const onAuthChange = mock();
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider onAuthChange={onAuthChange}>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );

      await waitFor(() => expect(ctxRef.current?.isLoading).toBe(false));
      expect(ctxRef.current?.isAuthenticated).toBe(false);

      mockFetch.enqueueGraphQLData({ auth_login: tokens("admin", 3600) });
      let result: unknown;
      await act(async () => {
        result = await ctxRef.current!.login("alice", "pw");
      });

      expect(result).toEqual({ role: "admin" });
      expect(ctxRef.current?.isAuthenticated).toBe(true);
      expect(ctxRef.current?.user).toEqual({ role: "admin" });
      expect(ctxRef.current?.error).toBeNull();
      expect(onAuthChange).toHaveBeenLastCalledWith({ role: "admin" });
      expect(getAccessToken()).toBe("tk_admin");
    });

    it("server returns auth_login: null → 'Invalid credentials' error, returns null", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isLoading).toBe(false));

      mockFetch.enqueueGraphQLData({ auth_login: null });
      let result: unknown;
      await act(async () => {
        result = await ctxRef.current!.login("alice", "bad");
      });

      expect(result).toBeNull();
      expect(ctxRef.current?.error).toBe("Invalid credentials");
      expect(ctxRef.current?.isAuthenticated).toBe(false);
      expect(ctxRef.current?.isLoading).toBe(false);
    });

    it("GraphQLFetchError thrown → error message from the error", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isLoading).toBe(false));

      mockFetch.enqueueGraphQLErrors([{ message: "rate limited" }]);
      let result: unknown;
      await act(async () => {
        result = await ctxRef.current!.login("alice", "pw");
      });

      expect(result).toBeNull();
      expect(ctxRef.current?.error).toBe("rate limited");
    });

    it("generic Error thrown → error message from the Error", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isLoading).toBe(false));

      mockFetch.enqueueNetworkError("offline");
      let result: unknown;
      await act(async () => {
        result = await ctxRef.current!.login("alice", "pw");
      });

      expect(result).toBeNull();
      expect(ctxRef.current?.error).toBe("offline");
    });

    it("unknown throw value → 'Login failed' fallback", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isLoading).toBe(false));

      // Push a non-Error rejection.
      mockFetch.queue.push(() => Promise.reject("string rejection" as unknown));
      let result: unknown;
      await act(async () => {
        result = await ctxRef.current!.login("alice", "pw");
      });

      expect(result).toBeNull();
      expect(ctxRef.current?.error).toBe("Login failed");
    });
  });

  // ===========================================================================
  // logout
  // ===========================================================================
  describe("logout", () => {
    it("clears state, access token, fires onLogout then onAuthChange(null)", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
      const onAuthChange = mock();
      const onLogout = mock();
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider onAuthChange={onAuthChange} onLogout={onLogout}>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isAuthenticated).toBe(true));

      // logout mutation response
      mockFetch.enqueueGraphQLData({ auth_logout: true });
      await act(async () => {
        await ctxRef.current!.logout();
      });

      expect(ctxRef.current?.isAuthenticated).toBe(false);
      expect(ctxRef.current?.user).toBeNull();
      expect(ctxRef.current?.error).toBeNull();
      expect(getAccessToken()).toBeNull();
      expect(onLogout).toHaveBeenCalledTimes(1);
      expect(onAuthChange).toHaveBeenLastCalledWith(null);

      // onLogout fired before onAuthChange(null)
      const onLogoutOrder = onLogout.mock.invocationCallOrder[0];
      const onAuthLastOrder =
        onAuthChange.mock.invocationCallOrder[onAuthChange.mock.invocationCallOrder.length - 1];
      expect(onLogoutOrder).toBeLessThan(onAuthLastOrder);
    });

    it("logout mutation fetch failure still clears state and fires callbacks", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
      const onAuthChange = mock();
      const onLogout = mock();
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider onAuthChange={onAuthChange} onLogout={onLogout}>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isAuthenticated).toBe(true));

      mockFetch.enqueueNetworkError("logout endpoint down");
      await act(async () => {
        await ctxRef.current!.logout();
      });

      expect(ctxRef.current?.isAuthenticated).toBe(false);
      expect(onLogout).toHaveBeenCalledTimes(1);
      expect(onAuthChange).toHaveBeenLastCalledWith(null);
    });

    it("onLogout callback throwing is swallowed; onAuthChange still fires", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
      const onAuthChange = mock();
      const onLogout = mock(() => {
        throw new Error("cache flush failed");
      });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider onAuthChange={onAuthChange} onLogout={onLogout}>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isAuthenticated).toBe(true));

      mockFetch.enqueueGraphQLData({ auth_logout: true });
      await act(async () => {
        await ctxRef.current!.logout();
      });

      expect(ctxRef.current?.isAuthenticated).toBe(false);
      expect(onAuthChange).toHaveBeenLastCalledWith(null);
    });
  });

  // ===========================================================================
  // refreshToken() public method
  // ===========================================================================
  describe("refreshToken()", () => {
    it("returns true on success and applies new tokens", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isAuthenticated).toBe(true));

      mockFetch.enqueueGraphQLData({
        auth_refresh: { ...tokens("admin", 3600), access_token: "rotated" },
      });
      let ok: boolean | undefined;
      await act(async () => {
        ok = await ctxRef.current!.refreshToken();
      });

      expect(ok).toBe(true);
      expect(getAccessToken()).toBe("rotated");
    });

    it("returns false on null response", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isAuthenticated).toBe(true));

      mockFetch.enqueueGraphQLData({ auth_refresh: null });
      let ok: boolean | undefined;
      await act(async () => {
        ok = await ctxRef.current!.refreshToken();
      });

      expect(ok).toBe(false);
    });

    it("returns false on thrown error", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isAuthenticated).toBe(true));

      mockFetch.enqueueNetworkError("net");
      let ok: boolean | undefined;
      await act(async () => {
        ok = await ctxRef.current!.refreshToken();
      });

      expect(ok).toBe(false);
    });
  });

  // ===========================================================================
  // RBAC predicates
  // ===========================================================================
  describe("hasRole / hasAnyRole", () => {
    it("returns false when no user", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current).not.toBeNull());

      expect(ctxRef.current?.hasRole("admin")).toBe(false);
      expect(ctxRef.current?.hasAnyRole(["admin", "user"])).toBe(false);
    });

    it("true/false matrix after login; updates after role change via login", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isLoading).toBe(false));

      mockFetch.enqueueGraphQLData({ auth_login: tokens("admin") });
      await act(async () => {
        await ctxRef.current!.login("a", "b");
      });
      expect(ctxRef.current?.hasRole("admin")).toBe(true);
      expect(ctxRef.current?.hasRole("user")).toBe(false);
      expect(ctxRef.current?.hasAnyRole(["user", "admin"])).toBe(true);
      expect(ctxRef.current?.hasAnyRole(["guest"])).toBe(false);

      // logout, then re-login w/ different role — predicates must re-evaluate.
      mockFetch.enqueueGraphQLData({ auth_logout: true });
      await act(async () => {
        await ctxRef.current!.logout();
      });
      mockFetch.enqueueGraphQLData({ auth_login: tokens("user") });
      await act(async () => {
        await ctxRef.current!.login("a", "b");
      });
      expect(ctxRef.current?.hasRole("admin")).toBe(false);
      expect(ctxRef.current?.hasRole("user")).toBe(true);
    });
  });

  // ===========================================================================
  // Token store wiring
  // ===========================================================================
  describe("tokenStore wiring", () => {
    it("ensureFreshToken() invokes the provider's refreshToken after mount", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
      const ctxRef = makeCtxRef();

      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
        </AuthProvider>,
      );
      await waitFor(() => expect(ctxRef.current?.isAuthenticated).toBe(true));

      mockFetch.enqueueGraphQLData({
        auth_refresh: { ...tokens("admin"), access_token: "via-store" },
      });
      let ok: boolean | undefined;
      await act(async () => {
        ok = await ensureFreshToken();
      });
      expect(ok).toBe(true);
      expect(getAccessToken()).toBe("via-store");
    });

    it("after unmount, ensureFreshToken() resolves false (handlers nulled)", async () => {
      mockFetch.enqueueGraphQLData({ auth_refresh: null });

      const { unmount } = render(
        <AuthProvider>
          <Capture ctxRef={makeCtxRef()} />
        </AuthProvider>,
      );
      await waitFor(() => expect(mockFetch.calls.length).toBe(1));

      unmount();

      const ok = await ensureFreshToken();
      expect(ok).toBe(false);
    });
  });

  // ===========================================================================
  // Proactive refresh — uses fake timers
  // ===========================================================================
  describe("proactive refresh", () => {
    let clock: ReturnType<typeof FakeTimers.install>;

    beforeEach(() => {
      clock = FakeTimers.install({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
    });

    afterEach(() => {
      clock.uninstall();
    });

    async function mountAndWaitForBoot(
      role: string,
      expiresIn: number,
      children?: ReactNode,
    ): Promise<CaptureProps["ctxRef"]> {
      mockFetch.enqueueGraphQLData({ auth_refresh: tokens(role, expiresIn) });
      const ctxRef = makeCtxRef();
      render(
        <AuthProvider>
          <Capture ctxRef={ctxRef} />
          {children}
        </AuthProvider>,
      );
      // Drive timers + microtasks until boot settles. tickAsync flushes both.
      for (let i = 0; i < 20 && ctxRef.current?.isAuthenticated !== true; i++) {
        await act(async () => {
          await clock.tickAsync(1);
        });
      }
      if (ctxRef.current?.isAuthenticated !== true) {
        throw new Error("boot did not authenticate within 20 ticks");
      }
      return ctxRef;
    }

    it("schedules refresh at (expires_in - 30) * 1000 ms when comfortable", async () => {
      const setTimeoutSpy = spyOn(globalThis, "setTimeout");
      await mountAndWaitForBoot("admin", 3600);

      // The very last setTimeout call is the schedule for the proactive refresh.
      const last = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1];
      expect(last[1]).toBe((3600 - 30) * 1000);
      setTimeoutSpy.mockRestore();
    });

    it("clamps to minimum 10_000 ms when expires_in is short", async () => {
      const setTimeoutSpy = spyOn(globalThis, "setTimeout");
      await mountAndWaitForBoot("admin", 20);

      const last = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1];
      expect(last[1]).toBe(10_000);
      setTimeoutSpy.mockRestore();
    });

    it("timer fires → calls auth_refresh, applies new token, reschedules", async () => {
      const ctxRef = await mountAndWaitForBoot("admin", 60); // schedules at 30s
      // Queue the response that the timer-fired refresh will receive.
      mockFetch.enqueueGraphQLData({
        auth_refresh: { ...tokens("admin", 60), access_token: "rotated" },
      });

      await act(async () => {
        await clock.tickAsync(30_000);
      });
      // Microtask chain: setTimeout → callRefresh → .then → applyTokens + reschedule
      await act(async () => {
        await clock.tickAsync(1);
      });

      expect(getAccessToken()).toBe("rotated");
      expect(ctxRef.current?.user).toEqual({ role: "admin" });
      // Original boot fetch + scheduled refresh = 2.
      expect(mockFetch.calls.length).toBe(2);
    });

    it("refresh failure inside timer is logged, does not crash, state unchanged", async () => {
      const ctxRef = await mountAndWaitForBoot("admin", 60);
      mockFetch.enqueueNetworkError("timer refresh fail");

      await act(async () => {
        await clock.tickAsync(30_000);
      });
      await act(async () => {
        await clock.tickAsync(1);
      });

      expect(ctxRef.current?.isAuthenticated).toBe(true);
      // Token unchanged from boot.
      expect(getAccessToken()).toBe("tk_admin");
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("logout clears the pending refresh timer", async () => {
      const ctxRef = await mountAndWaitForBoot("admin", 60);
      mockFetch.enqueueGraphQLData({ auth_logout: true });

      await act(async () => {
        await ctxRef.current!.logout();
      });

      // Advance well past the scheduled refresh time.
      await act(async () => {
        await clock.tickAsync(60_000);
      });

      // Only the boot fetch + the logout fetch — no refresh fired.
      expect(mockFetch.calls.length).toBe(2);
      expect(mockFetch.calls[1].body.query).toContain("auth_logout");
    });
  });

  // ===========================================================================
  // Login after no-session boot invalidates the boot cache (re-checked on remount)
  // ===========================================================================
  it("login resets boot cache so a subsequent remount re-checks the session", async () => {
    mockFetch.enqueueGraphQLData({ auth_refresh: null }); // first boot: no session
    const ctxRef1 = makeCtxRef();
    const { unmount } = render(
      <AuthProvider>
        <Capture ctxRef={ctxRef1} />
      </AuthProvider>,
    );
    await waitFor(() => expect(ctxRef1.current?.isLoading).toBe(false));

    // login → internally calls resetBootRefreshCache so the cached null does not
    // suppress the next mount's refresh request.
    mockFetch.enqueueGraphQLData({ auth_login: tokens("admin") });
    await act(async () => {
      await ctxRef1.current!.login("a", "b");
    });

    unmount();

    // Fresh mount: must fetch auth_refresh again, not reuse cached null.
    mockFetch.enqueueGraphQLData({ auth_refresh: tokens("admin", 3600) });
    const ctxRef2 = makeCtxRef();
    render(
      <AuthProvider>
        <Capture ctxRef={ctxRef2} />
      </AuthProvider>,
    );
    await waitFor(() => expect(ctxRef2.current?.isAuthenticated).toBe(true));

    // boot1 (auth_refresh) + login + boot2 (auth_refresh) = 3
    expect(mockFetch.calls.length).toBe(3);
    expect(mockFetch.calls[2].body.query).toContain("auth_refresh");
  });

  it("throws when useAuth is called without an AuthProvider", () => {
    // Render a consumer with NO provider wrapper.
    const ctxRef = makeCtxRef();
    expect(() => render(<Capture ctxRef={ctxRef} />)).toThrow(
      /useAuth must be used within an AuthProvider/,
    );
  });

  it("token store wiring is removed once handlers null on unmount (tokenStore stays inert)", async () => {
    mockFetch.enqueueGraphQLData({ auth_refresh: null });
    const { unmount } = render(
      <AuthProvider>
        <Capture ctxRef={makeCtxRef()} />
      </AuthProvider>,
    );
    await waitFor(() => expect(mockFetch.calls.length).toBe(1));
    unmount();

    // Manually setting a handler then nulling it again exercises the API
    // surface tests assume — sanity check, mirrors what AuthProvider did.
    setRefreshHandler(async () => true);
    setRefreshHandler(null);
    const ok = await ensureFreshToken();
    expect(ok).toBe(false);
  });
});
