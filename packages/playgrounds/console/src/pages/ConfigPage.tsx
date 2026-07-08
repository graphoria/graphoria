import type { ConfigResponse } from "../client";

import { useApi } from "../useApi";

export const ConfigPage = () => {
  const { data, error, loading } = useApi<ConfigResponse>("/config");

  if (loading) return <p className="text-gray-400">Loading…</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <>
      <h1 className="text-xl font-bold mb-4">Configuration</h1>
      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <p>
          <strong>{data!.name}</strong> <span className="text-gray-400">v{data!.version}</span>
        </p>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">Endpoints</h2>
        <table className="w-full text-sm">
          <tbody>
            {Object.entries(data!.prefixes).map(([name, path]) => (
              <tr key={name} className="border-b border-gray-100">
                <td className="py-2 pr-4">{name}</td>
                <td className="font-mono text-sm py-2">
                  <a
                    href={path}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {path}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">Features</h2>
        <table className="w-full text-sm">
          <tbody>
            {Object.entries(data!.features).map(([name, enabled]) => (
              <tr key={name} className="border-b border-gray-100">
                <td className="py-2 pr-4">{name}</td>
                <td className="py-2">
                  <span
                    className={
                      enabled
                        ? "inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5"
                        : "inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5"
                    }
                  />
                  {enabled ? "enabled" : "disabled"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};
