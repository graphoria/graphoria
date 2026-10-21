import { useState } from "react";

import type { AiEntry } from "../aiHistory";
import type { AiRolesResponse, ConfigResponse } from "../client";

import { ask, cancel, useAiHistory } from "../aiHistory";
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

const Queries = ({ queries, graphiql }: { queries: string[]; graphiql?: string }) => (
  <details className="mt-3 border-t border-gray-100 pt-2">
    <summary className="cursor-pointer text-sm text-gray-500">Queries ({queries.length})</summary>
    {queries.map((query, index) => (
      <div key={index} className="mt-2">
        <pre className="bg-gray-50 rounded p-2 text-xs font-mono overflow-x-auto">{query}</pre>
        <div className="flex gap-3 mt-1 text-sm">
          <CopyButton text={query} />
          {graphiql && (
            <a
              href={`${graphiql}?query=${encodeURIComponent(query)}`}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline"
            >
              Open in GraphiQL
            </a>
          )}
        </div>
      </div>
    ))}
  </details>
);

const Entry = ({ entry, graphiql }: { entry: AiEntry; graphiql?: string }) => (
  <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
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
      <>
        {/* The server's renderer escapes all text and writes every tag itself. */}
        <div
          className="ai-answer text-sm"
          dangerouslySetInnerHTML={{ __html: entry.answer.answerHtml }}
        />
        {entry.answer.queries.length > 0 && (
          <Queries queries={entry.answer.queries} graphiql={graphiql} />
        )}
      </>
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
