// ============================================================================
// Login Page
// ============================================================================

import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useAuth, useRouteConfig } from "@graphoria/react";
import { LoadingIcon } from "../components/icons";

export function LoginPage() {
  const { login, isLoading, error } = useAuth();
  const { getRedirectPath } = useRouteConfig();
  const [, setLocation] = useLocation();
  const searchString = useSearch();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Parse returnTo from URL
  const params = new URLSearchParams(searchString);
  const returnTo = params.get("returnTo");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!username.trim() || !password.trim()) return;

    const user = await login(username, password);

    if (user) {
      const target = getRedirectPath(
        user.role,
        returnTo ? decodeURIComponent(returnTo) : undefined,
      );

      setLocation(target);
    }
  };

  const canSubmit = username.trim().length > 0 && password.trim().length > 0;

  return (
    <div className="min-h-full flex items-center justify-center">
      <div className="w-full max-w-sm">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">Taskly</h1>
          <p className="text-gray-400 mt-2">Sign in to your account</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Error Message */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Username */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              autoComplete="username"
              autoFocus
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Password */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isLoading || !canSubmit}
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-900"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <LoadingIcon />
                Signing in...
              </span>
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        {/* Demo credentials, seeded via `bunx graphoria seed-auth`. */}
        <p className="text-center text-xs text-gray-500 mt-6">
          Demo login: <span className="text-gray-400">evan</span> /{" "}
          <span className="text-gray-400">s3cret</span>
        </p>
      </div>
    </div>
  );
}
