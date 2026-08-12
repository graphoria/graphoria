import { useEffect, useState } from "react";

import type {
  PermissionValue,
  RoleEntitiesResponse,
  RolesResponse,
  SchemaResponse,
} from "../client";

import { apiFetch } from "../client";
import { useApi } from "../useApi";

const Permission = ({ value }: { value: PermissionValue }) => {
  if (value === "ALL")
    return <span className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">ALL</span>;

  if (Array.isArray(value))
    return <span className="font-mono text-sm">{value.join(", ") || "none"}</span>;

  return (
    <ul className="list-disc pl-5">
      {Object.entries(value).map(([name, entry]) => (
        <li key={name}>
          <span className="font-mono text-sm">{name}</span>
          {entry === "ALL" ? (
            <span className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full ml-2">
              ALL
            </span>
          ) : (
            <>
              {entry.columns && (
                <span className="text-gray-400 text-sm">
                  {" "}
                  columns: {entry.columns === "ALL" ? "ALL" : entry.columns.join(", ")}
                </span>
              )}
              {entry.filter != null && (
                <span className="text-gray-400 text-sm">
                  {" "}
                  filter: {JSON.stringify(entry.filter)}
                </span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
};

const summarize = (value: PermissionValue | undefined) => {
  if (value === undefined) return "–";
  if (value === "ALL") return "ALL";
  if (Array.isArray(value)) return value.length ? String(value.length) : "–";
  return "partial";
};

const PermissionMatrix = ({ data }: { data: RolesResponse }) => {
  const sources = [
    ...new Set(Object.values(data.permissions).flatMap((permission) => Object.keys(permission))),
  ].sort();

  if (sources.length === 0) return null;

  return (
    <div className="bg-white rounded-lg shadow-sm p-4 mb-3 overflow-x-auto">
      <h2 className="text-lg font-semibold mb-2">Overview</h2>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200">
          <tr>
            <th className="text-left py-2 pr-4 text-gray-500 font-medium">Source</th>
            {data.roles.map((role) => (
              <th key={role} className="text-left py-2 pr-4 text-gray-500 font-medium">
                {role}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source} className="border-b border-gray-100">
              <td className="py-1.5 pr-4">{source}</td>
              {data.roles.map((role) => (
                <td key={role} className="py-1.5 pr-4">
                  {role === "superadmin" ? "ALL" : summarize(data.permissions[role]?.[source])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const RoleBrowser = ({ roles }: { roles: string[] }) => {
  const [role, setRole] = useState(roles[0] ?? "");
  const [entities, setEntities] = useState<RoleEntitiesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!role) return;
    let stale = false;
    setEntities(null);
    setError(null);
    apiFetch<RoleEntitiesResponse>(`/roles/entities?role=${encodeURIComponent(role)}`)
      .then((response) => {
        if (!stale) setEntities(response);
      })
      .catch((err) => {
        if (!stale) setError((err as Error).message);
      });
    return () => {
      stale = true;
    };
  }, [role]);

  return (
    <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-lg font-semibold">Entities by role</h2>
        <select
          className="border border-gray-200 rounded px-2 py-1 text-sm"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          {roles.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-red-500 text-sm">{error}</p>}
      {!entities && !error && <p className="text-gray-400 text-sm">Loading…</p>}
      {entities && (
        <>
          <h3 className="text-sm font-medium text-gray-500 mt-2">
            Tables ({entities.tables.length})
          </h3>
          <ul className="mb-2">
            {entities.tables.map((table) => (
              <li key={`${table.schema}.${table.name}`} className="text-sm">
                <span className="font-mono">
                  {table.schema}.{table.name}
                </span>
                <span className="text-gray-400"> cols: {table.columns.join(", ")}</span>
              </li>
            ))}
          </ul>
          <h3 className="text-sm font-medium text-gray-500">
            Operations ({entities.operations.length})
          </h3>
          <ul className="mb-2">
            {entities.operations.map((operation) => (
              <li key={operation.name} className="text-sm font-mono">
                {operation.name}
                {operation.method && (
                  <span className="text-gray-400">
                    {" "}
                    {operation.method} {operation.path}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {entities.remoteSchemas.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-gray-500">
                Remote schemas ({entities.remoteSchemas.length})
              </h3>
              <ul className="mb-2">
                {entities.remoteSchemas.map((schema) => (
                  <li key={schema.name} className="text-sm font-mono">
                    {schema.name}
                    <span className="text-gray-400">
                      {" "}
                      {schema.queryFields} queries, {schema.mutationFields} mutations
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {entities.remoteREST.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-gray-500">
                Remote REST ({entities.remoteREST.length})
              </h3>
              <ul>
                {entities.remoteREST.map((api) => (
                  <li key={api.name} className="text-sm font-mono">
                    {api.name}
                    <span className="text-gray-400"> {api.routes} routes</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
};

const RoleSdl = ({ role }: { role: string }) => {
  const [sdl, setSdl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    apiFetch<SchemaResponse>(`/schema?role=${encodeURIComponent(role)}`)
      .then((response) => setSdl(response.sdl))
      .catch((err) => setError((err as Error).message));

  const download = () => {
    const url = URL.createObjectURL(new Blob([sdl!], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${role}.graphql`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <p className="text-red-500 text-sm mt-2">{error}</p>;

  if (sdl === null)
    return (
      <button
        className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer mt-2"
        onClick={load}
      >
        View SDL
      </button>
    );

  return (
    <div className="mt-2">
      <div className="flex gap-4 mb-1">
        <button
          className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          onClick={() => setSdl(null)}
        >
          Hide SDL
        </button>
        <button
          className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          onClick={download}
        >
          Download
        </button>
      </div>
      <pre className="bg-gray-50 rounded p-3 text-xs overflow-x-auto max-h-96 overflow-y-auto">
        {sdl}
      </pre>
    </div>
  );
};

export const RolesPage = () => {
  const { data, error, loading } = useApi<RolesResponse>("/roles");

  if (loading) return <p className="text-gray-400">Loading…</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <>
      <h1 className="text-xl font-bold mb-4">Roles</h1>
      <PermissionMatrix data={data!} />
      <RoleBrowser roles={data!.roles} />
      {data!.roles.map((role) => {
        const permissions = data!.permissions[role];
        return (
          <div key={role} className="bg-white rounded-lg shadow-sm p-4 mb-3">
            <h2 className="text-lg font-semibold mb-2">{role}</h2>
            {role === "superadmin" ? (
              <p className="text-gray-400">Full access (implicit ALL on every source).</p>
            ) : !permissions ? (
              <p className="text-gray-400">No permissions configured.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(permissions).map(([source, value]) => (
                    <tr key={source} className="border-b border-gray-100">
                      <td className="py-2 pr-4 align-top">{source}</td>
                      <td className="py-2">
                        <Permission value={value} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <RoleSdl role={role} />
          </div>
        );
      })}
    </>
  );
};
