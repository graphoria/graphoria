import { useState } from "react";

import type { Meta } from "./client";

import { apiFetch, clearSecret, setSecret } from "./client";

export const Login = ({ meta, onSuccess }: { meta: Meta; onSuccess: () => void }) => {
  const [secret, setSecretInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSecret(secret);
    try {
      await apiFetch("/config");
      onSuccess();
    } catch {
      clearSecret();
      setError("Invalid admin secret");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <form onSubmit={submit} className="w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-2">{meta.name}</h1>
        <p className="text-gray-400 mb-4">Enter the admin secret to open the console.</p>
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecretInput(event.target.value)}
          placeholder="Admin secret"
          autoFocus
          className="w-full px-3 py-2 border border-gray-300 rounded bg-white text-gray-900 mb-4 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={busy || secret.length === 0}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded font-medium disabled:opacity-50 cursor-pointer hover:bg-blue-700"
        >
          {busy ? "Checking…" : "Open console"}
        </button>
        {error && <p className="text-red-500 mt-2 text-sm">{error}</p>}
      </form>
    </div>
  );
};
