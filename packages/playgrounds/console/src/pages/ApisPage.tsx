import type { ApisResponse, ConfigResponse } from "../client";

import { useApi } from "../useApi";

const scalarOperationHref = (scalarPrefix: string, operation: ApisResponse["operations"][number]) =>
  `${scalarPrefix}#tag/${operation.tag.toLowerCase()}/${operation.method.toUpperCase()}${operation.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;

export const ApisPage = () => {
  const { data, error, loading } = useApi<ApisResponse>("/apis");
  const { data: config } = useApi<ConfigResponse>("/config");

  if (loading) return <p className="text-gray-400">Loading…</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  const scalar = config?.prefixes.scalar;
  const openapi = config?.prefixes.openapi;

  return (
    <>
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-xl font-bold">APIs</h1>
        {scalar && (
          <a
            href={scalar}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-gray-500 hover:text-gray-900"
          >
            Scalar docs ↗
          </a>
        )}
        {openapi && (
          <a
            href={openapi}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-gray-500 hover:text-gray-900"
          >
            openapi.json ↗
          </a>
        )}
      </div>
      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">REST operations</h2>
        {data!.operations.length === 0 ? (
          <p className="text-gray-400">None configured.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200">
              <tr>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Name</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Method</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Path</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {data!.operations.map((operation) => (
                <tr key={operation.name} className="border-b border-gray-100">
                  <td className="font-mono text-sm py-1.5 pr-2">{operation.name}</td>
                  <td className="font-mono text-sm py-1.5 pr-2">{operation.method}</td>
                  <td className="font-mono text-sm py-1.5 pr-2">{operation.path}</td>
                  <td className="py-1.5 pr-2">
                    {scalar && (
                      <a
                        href={scalarOperationHref(scalar, operation)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-gray-500 hover:text-gray-900"
                      >
                        Scalar ↗
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">Remote REST APIs</h2>
        {data!.remoteREST.length === 0 ? (
          <p className="text-gray-400">None configured.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200">
              <tr>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Name</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Prefix</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Base URL</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Routes</th>
              </tr>
            </thead>
            <tbody>
              {data!.remoteREST.map((api) => (
                <tr key={api.name} className="border-b border-gray-100">
                  <td className="font-mono text-sm py-1.5 pr-2">{api.name}</td>
                  <td className="font-mono text-sm py-1.5 pr-2">{api.prefix}</td>
                  <td className="font-mono text-sm py-1.5 pr-2">{api.baseUrl}</td>
                  <td className="py-1.5 pr-2">{api.routes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">Remote GraphQL schemas</h2>
        {data!.remoteSchemas.length === 0 ? (
          <p className="text-gray-400">None configured.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200">
              <tr>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Name</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Prefix</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">URL</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Queries</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Mutations</th>
              </tr>
            </thead>
            <tbody>
              {data!.remoteSchemas.map((schema) => (
                <tr key={schema.name} className="border-b border-gray-100">
                  <td className="font-mono text-sm py-1.5 pr-2">{schema.name}</td>
                  <td className="font-mono text-sm py-1.5 pr-2">{schema.prefix}</td>
                  <td className="font-mono text-sm py-1.5 pr-2">{schema.url}</td>
                  <td className="py-1.5 pr-2">{schema.queryFields}</td>
                  <td className="py-1.5 pr-2">{schema.mutationFields}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
};
