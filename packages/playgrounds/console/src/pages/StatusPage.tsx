import { useState } from "react";

import type { StatusResponse } from "../client";

import { apiPost } from "../client";
import { useApi } from "../useApi";

const formatUptime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const PublishForm = ({ publishers }: { publishers: string[] }) => {
  const [publisher, setPublisher] = useState(publishers[0] ?? "");
  const [message, setMessage] = useState("");
  const [key, setKey] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      let payload: string | object = message;
      try {
        payload = JSON.parse(message);
      } catch {
        /* send as plain string */
      }
      const { ok } = await apiPost<{ ok: boolean }>("/queues/publish", {
        publisher,
        message: payload,
        key: key || undefined,
      });
      setResult(ok ? "Message published." : "Broker rejected the message.");
    } catch (error) {
      setResult((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <div className="flex gap-2 mb-2">
        <select
          className="border border-gray-200 rounded px-2 py-1 text-sm"
          value={publisher}
          onChange={(event) => setPublisher(event.target.value)}
        >
          {publishers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input
          className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
          placeholder="routing key (optional)"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </div>
      <textarea
        className="w-full border border-gray-200 rounded px-2 py-1 text-sm font-mono mb-2"
        rows={3}
        placeholder='{"hello": "world"} or plain text'
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <button
        className="text-sm bg-gray-900 text-white rounded px-3 py-1 cursor-pointer disabled:opacity-50"
        disabled={sending || !publisher || !message}
        onClick={send}
      >
        {sending ? "Sending…" : "Send message"}
      </button>
      {result && <p className="text-sm text-gray-500 mt-2">{result}</p>}
    </div>
  );
};

const CronActions = ({ name, isRunning }: { name: string; isRunning: boolean }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "trigger" | "pause" | "resume") => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/cron", { name, action });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex gap-2 items-center">
      <button
        className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer disabled:opacity-50"
        disabled={busy}
        onClick={() => act("trigger")}
      >
        Trigger
      </button>
      <button
        className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer disabled:opacity-50"
        disabled={busy}
        onClick={() => act(isRunning ? "pause" : "resume")}
      >
        {isRunning ? "Pause" : "Resume"}
      </button>
      {error && <span className="text-red-500 text-xs">{error}</span>}
    </span>
  );
};

export const StatusPage = () => {
  const { data, error, loading } = useApi<StatusResponse>("/status", 5000);

  if (loading) return <p className="text-gray-400">Loading…</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <>
      <h1 className="text-xl font-bold mb-4">Status</h1>
      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <p>
          Uptime: <strong>{formatUptime(data!.uptimeSeconds)}</strong> · Token strategy:{" "}
          <span className="font-mono text-sm">{data!.tokenStrategy}</span> · Memory:{" "}
          <strong>{formatBytes(data!.memoryRssBytes)}</strong> · Bun:{" "}
          <span className="font-mono text-sm">{data!.bunVersion}</span> · PID:{" "}
          <span className="font-mono text-sm">{data!.pid}</span>
        </p>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">Databases</h2>
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200">
            <tr>
              <th className="text-left py-2 pr-2 text-gray-500 font-medium">Name</th>
              <th className="text-left py-2 pr-2 text-gray-500 font-medium">Engine</th>
              <th className="text-left py-2 pr-2 text-gray-500 font-medium">Connected</th>
              <th className="text-left py-2 pr-2 text-gray-500 font-medium">Latency</th>
            </tr>
          </thead>
          <tbody>
            {data!.databases.map((db) => (
              <tr key={db.name} className="border-b border-gray-100">
                <td className="font-mono text-sm py-1.5 pr-2">{db.name}</td>
                <td className="py-1.5 pr-2">{db.type}</td>
                <td className="py-1.5 pr-2">
                  <span
                    className={
                      db.connected
                        ? "inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5"
                        : "inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5"
                    }
                  />
                  {db.connected ? "connected" : "disconnected"}
                </td>
                <td className="py-1.5 pr-2">{db.latencyMs != null ? `${db.latencyMs} ms` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">Queues</h2>
        {data!.queueConnections.length === 0 ? (
          <p className="text-gray-400 mb-2">No brokers connected.</p>
        ) : (
          <p className="mb-2">
            {data!.queueConnections.map((connection, index) => (
              <span key={index} className="mr-4">
                <span
                  className={
                    connection.connected
                      ? "inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5"
                      : "inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5"
                  }
                />
                {connection.type} {connection.connected ? "connected" : "disconnected"}
              </span>
            ))}
          </p>
        )}
        <p className="text-sm">
          <span className="text-gray-500">Publishers: </span>
          {data!.publishers.length === 0 ? (
            <span className="text-gray-400">none</span>
          ) : (
            <span className="font-mono">{data!.publishers.join(", ")}</span>
          )}
        </p>
        <p className="text-sm">
          <span className="text-gray-500">Subscribers: </span>
          {data!.subscribers.length === 0 ? (
            <span className="text-gray-400">none</span>
          ) : (
            <span className="font-mono">
              {data!.subscribers
                .map((subscriber) => `${subscriber.name} (${subscriber.topic})`)
                .join(", ")}
            </span>
          )}
        </p>
        {data!.publishers.length > 0 && <PublishForm publishers={data!.publishers} />}
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">Cron jobs</h2>
        {data!.cron.length === 0 ? (
          <p className="text-gray-400">None configured.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200">
              <tr>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Name</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Pattern</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Runs</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">State</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Next run</th>
                <th className="text-left py-2 pr-2 text-gray-500 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data!.cron.map((job) => (
                <tr key={job.name} className="border-b border-gray-100">
                  <td className="font-mono text-sm py-1.5 pr-2">{job.name}</td>
                  <td className="font-mono text-sm py-1.5 pr-2">{job.pattern}</td>
                  <td className="py-1.5 pr-2">{job.executionCount}</td>
                  <td className="py-1.5 pr-2">
                    {job.isBusy ? "busy" : job.isRunning ? "running" : "stopped"}
                  </td>
                  <td className="py-1.5 pr-2">
                    {job.nextRun ? new Date(job.nextRun).toLocaleString() : "—"}
                  </td>
                  <td className="py-1.5 pr-2">
                    <CronActions name={job.name} isRunning={job.isRunning} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
};
