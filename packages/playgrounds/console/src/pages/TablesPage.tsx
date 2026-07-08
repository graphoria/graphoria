import type { ConfigResponse, TablesResponse } from "../client";

import { useApi } from "../useApi";

type Table = TablesResponse["tables"][number];

const referencesFor = (table: Table, columnName: string) =>
  table.relationships.flatMap((relationship) =>
    relationship.columns
      .filter((column) => column.source === columnName)
      .map((column) => `${relationship.schema}.${relationship.name}.${column.target}`),
  );

const buildQuery = (table: Table) => {
  const fields = table.columns.slice(0, 5).map((column) => `    ${column.name}`);
  return `query {\n  ${table.resolverName} {\n${fields.join("\n")}\n  }\n}`;
};

export const TablesPage = () => {
  const { data, error, loading } = useApi<TablesResponse>("/tables");
  const { data: config } = useApi<ConfigResponse>("/config");

  if (loading) return <p className="text-gray-400">Loading…</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  const graphiqlPrefix = config?.prefixes.graphiql;

  return (
    <>
      <h1 className="text-xl font-bold mb-4">Tables</h1>
      {data!.tables.map((table) => (
        <details
          key={`${table.schema}.${table.name}`}
          className="bg-white rounded-lg shadow-sm mb-3"
        >
          <summary className="cursor-pointer flex items-center gap-3 py-3 px-4">
            <span className="font-mono text-sm">
              {table.schema}.{table.name}
            </span>
            <span className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">
              {table.entityType}
            </span>
            {table.description && (
              <span className="text-gray-400 text-sm">{table.description}</span>
            )}
            {graphiqlPrefix && (
              <a
                href={`${graphiqlPrefix}?query=${encodeURIComponent(buildQuery(table))}`}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-sm text-gray-500 hover:text-gray-900"
                onClick={(event) => event.stopPropagation()}
              >
                GraphiQL ↗
              </a>
            )}
          </summary>
          <div className="px-4 pb-4">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="text-left py-2 pr-2 text-gray-500 font-medium">Column</th>
                  <th className="text-left py-2 pr-2 text-gray-500 font-medium">Type</th>
                  <th className="text-left py-2 pr-2 text-gray-500 font-medium">Nullable</th>
                  <th className="text-left py-2 pr-2 text-gray-500 font-medium">Description</th>
                  <th className="text-left py-2 pr-2 text-gray-500 font-medium">References</th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((column) => (
                  <tr key={column.name} className="border-b border-gray-100">
                    <td className="font-mono text-sm py-1.5 pr-2">{column.name}</td>
                    <td className="font-mono text-sm py-1.5 pr-2">{column.dataType ?? "—"}</td>
                    <td className="py-1.5 pr-2">{column.isNullable ? "yes" : "no"}</td>
                    <td className="text-gray-400 py-1.5 pr-2">{column.description ?? ""}</td>
                    <td className="font-mono text-sm text-gray-500 py-1.5 pr-2">
                      {referencesFor(table, column.name)
                        .map((reference) => `→ ${reference}`)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      {data!.tables.length === 0 && <p className="text-gray-400">No tables exposed.</p>}
    </>
  );
};
