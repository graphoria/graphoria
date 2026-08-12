import { useEffect, useState } from "react";
import { Link, Redirect, Route, Router, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";

import type { Meta } from "./client";

import { clearSecret, getMeta, getSecret, onAuthFail, setAdminHeaderName } from "./client";
import { Login } from "./Login";
import { ApisPage } from "./pages/ApisPage";
import { ConfigPage } from "./pages/ConfigPage";
import { RolesPage } from "./pages/RolesPage";
import { StatusPage } from "./pages/StatusPage";
import { TablesPage } from "./pages/TablesPage";

import "./index.css";

const NAV = [
  { path: "/tables", label: "Tables" },
  { path: "/roles", label: "Roles" },
  { path: "/apis", label: "APIs" },
  { path: "/status", label: "Status" },
  { path: "/config", label: "Config" },
];

export const App = () => {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(getSecret() !== null);

  useEffect(() => {
    onAuthFail(() => {
      clearSecret();
      setAuthed(false);
    });
    getMeta()
      .then((m) => {
        setAdminHeaderName(m.adminSecretHeader);
        setMeta(m);
      })
      .catch((error) => setMetaError((error as Error).message));
  }, []);

  if (metaError) return <p className="text-red-500 text-center">{metaError}</p>;
  if (!meta) return <p className="text-gray-400 text-center">Loading…</p>;
  if (!authed) return <Login meta={meta} onSuccess={() => setAuthed(true)} />;

  return (
    <Router hook={useHashLocation}>
      <div className="flex min-h-screen bg-gray-50">
        <aside className="w-52 shrink-0 bg-gray-900 text-gray-300 flex flex-col py-4">
          <div className="flex flex-col px-4 pb-4 border-b border-gray-700">
            <strong>{meta.name}</strong>
            <span className="text-gray-400 text-sm">v{meta.version}</span>
          </div>
          <nav className="flex flex-col py-2 flex-1">
            {NAV.map(({ path, label }) => (
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
            onClick={() => {
              clearSecret();
              setAuthed(false);
            }}
          >
            Log out
          </button>
        </aside>
        <main className="flex-1 p-6">
          <Switch>
            <Route path="/tables" component={TablesPage} />
            <Route path="/roles" component={RolesPage} />
            <Route path="/apis" component={ApisPage} />
            <Route path="/status" component={StatusPage} />
            <Route path="/config" component={ConfigPage} />
            <Route>
              <Redirect to="/tables" />
            </Route>
          </Switch>
        </main>
      </div>
    </Router>
  );
};
