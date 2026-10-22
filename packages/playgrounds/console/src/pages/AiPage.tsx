import { useLayoutEffect, useRef, useState } from "react";

import type { AiEntry } from "../aiHistory";
import type { AiRolesResponse, ConfigResponse } from "../client";

import { ask, cancel, useAiHistory } from "../aiHistory";
import { apiPost } from "../client";
import { useApi } from "../useApi";

const CopyButton = ({ text }: { text: string }) => {
  const [label, setLabel] = useState("Copy");
  return (
    <button
      className="text-gray-500 hover:text-gray-900 cursor-pointer"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setLabel("Copied");
        } catch {
          setLabel("Copy failed");
        }
        setTimeout(() => setLabel("Copy"), 1500);
      }}
    >
      {label}
    </button>
  );
};

type GraphQLResponse = { data?: Record<string, unknown> | null; errors?: { message: string }[] };

type RunResult =
  | { state: "idle" | "running" }
  | { state: "done"; body: GraphQLResponse }
  | { state: "error"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tableRows = (value: unknown) => {
  if (isRecord(value)) return [value];
  if (Array.isArray(value) && value.every(isRecord)) return value;
  return undefined;
};

const Cell = ({ value }: { value: unknown }) => {
  if (value === undefined) return null;
  if (value === null) return <span className="text-gray-400">null</span>;
  if (typeof value === "object") return <span className="font-mono">{JSON.stringify(value)}</span>;
  return String(value);
};

const ResultTables = ({ body }: { body: GraphQLResponse }) => (
  <div className="mt-2 bg-gray-50 rounded p-2 text-xs max-h-96 overflow-auto space-y-3">
    {body.errors?.map((error, index) => (
      <p key={index} className="text-red-500">
        {error.message}
      </p>
    ))}
    {Object.entries(body.data ?? {}).map(([field, value]) => {
      const rows = tableRows(value);
      if (!rows)
        return (
          <p key={field}>
            <span className="font-mono text-gray-500">{field}</span> {JSON.stringify(value)}
          </p>
        );
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      return (
        <div key={field}>
          <p className="text-gray-500 mb-1">
            <span className="font-mono">{field}</span> {rows.length}{" "}
            {rows.length === 1 ? "row" : "rows"}
          </p>
          {rows.length > 0 && (
            <table className="border-separate border-spacing-0 tabular-nums">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column}
                      className="sticky top-0 bg-gray-50 border-b border-gray-200 py-1 pr-4 text-left font-medium text-gray-500 whitespace-nowrap"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => (
                      <td key={column} className="border-b border-gray-100 py-1 pr-4 align-top">
                        <Cell value={row[column]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      );
    })}
  </div>
);

const QueryRun = ({
  query,
  graphiql,
  role,
}: {
  query: string;
  graphiql?: string;
  role: string;
}) => {
  const [result, setResult] = useState<RunResult>({ state: "idle" });
  const [view, setView] = useState<"table" | "json">("table");

  const execute = async () => {
    setResult({ state: "running" });
    try {
      setResult({
        state: "done",
        body: await apiPost<GraphQLResponse>("/graphql", { query, role }),
      });
    } catch (error) {
      setResult({ state: "error", message: (error as Error).message });
    }
  };

  return (
    <div className="mt-2">
      <pre className="bg-gray-50 rounded p-2 text-xs font-mono whitespace-pre-wrap wrap-break-word">
        {query}
      </pre>
      <div className="flex flex-wrap gap-3 mt-1 text-sm">
        <CopyButton text={query} />
        {graphiql && (
          <a
            href={`${graphiql}?query=${encodeURIComponent(query)}`}
            target="_blank"
            rel="noreferrer"
            className="text-gray-500 hover:text-gray-900"
          >
            Open in GraphiQL
          </a>
        )}
        <button
          className="text-gray-500 hover:text-gray-900 cursor-pointer disabled:opacity-50"
          disabled={result.state === "running"}
          onClick={execute}
        >
          {result.state === "running" ? "Running…" : "Execute"}
        </button>
        {result.state === "done" && (
          <span className="ml-auto flex gap-3">
            {(["table", "json"] as const).map((option) => (
              <button
                key={option}
                aria-pressed={view === option}
                className={
                  view === option
                    ? "text-gray-900 font-medium"
                    : "text-gray-500 hover:text-gray-900 cursor-pointer"
                }
                onClick={() => setView(option)}
              >
                {option === "table" ? "Table" : "JSON"}
              </button>
            ))}
          </span>
        )}
      </div>
      {result.state === "error" && <p className="text-sm text-red-500 mt-2">{result.message}</p>}
      {result.state === "done" &&
        (view === "table" ? (
          <ResultTables body={result.body} />
        ) : (
          <pre className="bg-gray-50 rounded p-2 text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto mt-2">
            {JSON.stringify(result.body, null, 2)}
          </pre>
        ))}
    </div>
  );
};

const Queries = ({
  queries,
  graphiql,
  role,
}: {
  queries: string[];
  graphiql?: string;
  role: string;
}) => {
  const ref = useRef<HTMLDetailsElement>(null);

  // Open by default only beside the answer. The split is a container query, so
  // read the columns it laid out instead of repeating its breakpoint here.
  useLayoutEffect(() => {
    const details = ref.current;
    const grid = details?.parentElement;
    if (details && grid && getComputedStyle(grid).gridTemplateColumns.split(" ").length > 1)
      details.open = true;
  }, []);

  return (
    <details
      ref={ref}
      className="mt-3 border-t border-gray-100 pt-2 @5xl:mt-0 @5xl:border-t-0 @5xl:pt-0 @5xl:border-l @5xl:pl-6"
    >
      <summary className="cursor-pointer text-sm text-gray-500">
        Queries{" "}
        <span className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">
          {queries.length}
        </span>
      </summary>
      {queries.map((query, index) => (
        <QueryRun key={index} query={query} graphiql={graphiql} role={role} />
      ))}
    </details>
  );
};

const Entry = ({ entry, graphiql }: { entry: AiEntry; graphiql?: string }) => (
  <div className="@container bg-white rounded-lg shadow-sm p-4 mb-3">
    <div className="flex items-baseline gap-3 not-last:mb-2 not-last:pb-2 not-last:border-b not-last:border-gray-100">
      <p className="flex-1 min-w-0 font-medium whitespace-pre-wrap">{entry.prompt}</p>
      <span className="shrink-0 flex items-center gap-2 text-xs text-gray-400">
        <span className="bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">{entry.role}</span>
        {entry.status === "pending" ? (
          <>
            Thinking…
            <button
              className="text-gray-500 hover:text-gray-900 cursor-pointer"
              onClick={() => cancel(entry.id)}
            >
              Cancel
            </button>
          </>
        ) : entry.status === "cancelled" ? (
          "Cancelled"
        ) : (
          entry.elapsedMs !== undefined && `${(entry.elapsedMs / 1000).toFixed(1)} s`
        )}
      </span>
    </div>
    {entry.status === "error" && <p className="text-sm text-red-500">{entry.error}</p>}
    {entry.answer && (
      <div
        className={
          entry.answer.queries.length > 0 ? "grid grid-cols-1 gap-x-6 @5xl:grid-cols-2" : undefined
        }
      >
        <div>
          {entry.answer.answer.trim().length === 0 && (
            <p className="text-sm text-amber-600">The agent returned no text.</p>
          )}
          {/* The server's renderer escapes all text and writes every tag itself. */}
          <div
            className="ai-answer text-sm"
            dangerouslySetInnerHTML={{ __html: entry.answer.answerHtml }}
          />
        </div>
        {entry.answer.queries.length > 0 && (
          <Queries queries={entry.answer.queries} graphiql={graphiql} role={entry.role} />
        )}
      </div>
    )}
  </div>
);

export const AiPage = () => {
  const { data, error, loading } = useApi<AiRolesResponse>("/ai");
  const { data: config } = useApi<ConfigResponse>("/config");
  const entries = useAiHistory();
  const [role, setRole] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");

  if (loading) return <p className="text-gray-400">Loading…</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  const roles = data!.roles;
  const selected = role ?? roles[0] ?? "";
  const pending = entries.some((entry) => entry.status === "pending");
  const canAsk = !pending && prompt.trim().length > 0;

  const submit = () => {
    if (!canAsk) return;
    void ask(selected, prompt);
    setPrompt("");
  };

  return (
    <>
      <h1 className="text-xl font-bold mb-4">AI</h1>
      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        {selected !== roles[0] && (
          <p className="text-xs text-amber-600 mb-2">
            Reads as {selected} with no custom claims: <code>$session.claims.*</code> filters fail,
            and <code>$session.sub</code> is <code>console</code>.
          </p>
        )}
        <textarea
          aria-label="Question"
          className="w-full border border-gray-200 rounded px-2 py-1 text-sm field-sizing-content min-h-14 max-h-60"
          placeholder="How many orders per status?"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex flex-wrap gap-2 items-center mt-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-gray-500">Ask as</span>
            <select
              className="border border-gray-200 rounded px-2 py-1"
              value={selected}
              onChange={(event) => setRole(event.target.value)}
            >
              {roles.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <kbd className="ml-auto text-xs text-gray-400">Ctrl+Enter</kbd>
          <button
            className="text-sm bg-gray-900 text-white rounded px-3 py-1 cursor-pointer disabled:opacity-50"
            disabled={!canAsk}
            onClick={submit}
          >
            {pending ? "Asking…" : "Ask"}
          </button>
        </div>
      </div>
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} graphiql={config?.prefixes.graphiql} />
      ))}
    </>
  );
};
