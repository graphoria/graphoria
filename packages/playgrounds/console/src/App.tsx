import { useEffect, useState } from "react";
import { Link, Redirect, Route, Router, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";

import type { ConfigResponse, ConsoleScope, Meta } from "./client";

import mark from "../../public/graphoria-mark-dark.svg";
import { clearAiHistory } from "./aiHistory";
import { apiFetch, getMeta, logout, onAuthFail } from "./client";
import { Login } from "./Login";
import { AiPage } from "./pages/AiPage";
import { ApisPage } from "./pages/ApisPage";
import { ConfigPage } from "./pages/ConfigPage";
import { RolesPage } from "./pages/RolesPage";
import { StatusPage } from "./pages/StatusPage";
import { TablesPage } from "./pages/TablesPage";
import { UsersPage } from "./pages/UsersPage";

import "./index.css";

const NAV = [
  { path: "/tables", label: "Tables" },
  { path: "/roles", label: "Roles" },
  { path: "/apis", label: "APIs" },
  { path: "/status", label: "Status" },
  { path: "/config", label: "Config" },
];

const AI_NAV = { path: "/ai", label: "AI" };
const USERS_NAV = { path: "/users", label: "Users" };

export const App = () => {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  // The session cookie is httpOnly, so the only way to know whether one is
  // live, and what it may do, is to ask the server; `undefined` is "not asked
  // yet" and `null` is "no session".
  const [scope, setScope] = useState<ConsoleScope | null | undefined>(undefined);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  // The routes wait for the config read: until it resolves, `aiEnabled` and `authEnabled`
  // are false, so `#/ai` or `#/users` would fall through the catch-all redirect after a login.
  const [configReady, setConfigReady] = useState(false);

  // One read answers what the session may do and whether the agent is on. A login
  // returns the scope alone, so it reads again; the initial read ends the session on
  // failure, while after a login a failed read only leaves the agent off.
  const loadConfig = () =>
    apiFetch<ConfigResponse>("/config").then((config) => {
      setAiEnabled(config.features.ai === true);
      setAuthEnabled(config.features.auth === true);
      setScope(config.session.scope);
    });

  useEffect(() => {
    onAuthFail(() => {
      clearAiHistory();
      setAiEnabled(false);
      setAuthEnabled(false);
      setScope(null);
    });
    getMeta()
      .then(setMeta)
      .catch((error) => setMetaError((error as Error).message));
    loadConfig()
      .catch(() => setScope(null))
      .finally(() => setConfigReady(true));
  }, []);

  if (metaError) return <p className="text-red-500 text-center">{metaError}</p>;
  if (!meta || scope === undefined || !configReady)
    return <p className="text-gray-400 text-center">Loading…</p>;
  if (!scope)
    return (
      <Login
        meta={meta}
        onSuccess={(next) => {
          setScope(next);
          setConfigReady(false);
          loadConfig()
            .catch(() => {})
            .finally(() => setConfigReady(true));
        }}
      />
    );

  const showAi = aiEnabled && scope === "write";
  const nav = [...NAV, ...(authEnabled ? [USERS_NAV] : []), ...(showAi ? [AI_NAV] : [])];

  return (
    <Router hook={useHashLocation}>
      <div className="flex min-h-screen bg-gray-50">
        <aside className="w-52 shrink-0 bg-gray-900 text-gray-300 flex flex-col py-4">
          <div className="flex flex-col px-4 pb-4 border-b border-gray-700">
            <img src={mark} alt="Graphoria" className="w-8 h-8 mb-2" />
            <strong>{meta.name}</strong>
            <span className="text-gray-400 text-sm">v{meta.version}</span>
            {scope === "read" && (
              <span className="text-amber-400 text-xs mt-1">Read-only session</span>
            )}
          </div>
          <nav className="flex flex-col py-2 flex-1">
            {nav.map(({ path, label }) => (
              <Link
                key={path}
                href={path}
                className={(active) =>
                  active
                    ? "block px-4 py-2 text-white bg-gray-800"
                    : "block px-4 py-2 text-gray-400 hover:text-white"
                }
              >
                {label}
              </Link>
            ))}
          </nav>
          <button
            className="mt-auto mx-4 py-2 px-4 rounded text-gray-400 hover:text-white cursor-pointer text-left"
            onClick={async () => {
              await logout();
              clearAiHistory();
              setAiEnabled(false);
              setAuthEnabled(false);
              setScope(null);
            }}
          >
            Log out
          </button>
        </aside>
        {/* min-w-0 lets this flex item shrink below its content, so a wide table or query
            scrolls in its card instead of stretching the page. */}
        <main className="flex-1 min-w-0 p-6">
          <Switch>
            <Route path="/tables" component={TablesPage} />
            <Route path="/roles" component={RolesPage} />
            <Route path="/apis" component={ApisPage} />
            <Route path="/status">{() => <StatusPage readOnly={scope === "read"} />}</Route>
            <Route path="/config" component={ConfigPage} />
            {authEnabled && (
              <Route path="/users">{() => <UsersPage readOnly={scope === "read"} />}</Route>
            )}
            {showAi && <Route path="/ai" component={AiPage} />}
            <Route>
              <Redirect to="/tables" />
            </Route>
          </Switch>
        </main>
      </div>
    </Router>
  );
};
