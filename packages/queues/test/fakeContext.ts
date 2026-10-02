import type { QueueRuntimeContext } from "@graphoria/server";

export type FakeSpan = {
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
  status: { code: number };
};

const KIND_CODE = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;
const STATUS_CODE = { unset: 0, ok: 1, error: 2 } as const;

const LABEL_ORDER: Record<string, readonly string[]> = {
  graphoria_queue_messages_published_total: ["broker", "outcome", "publisher"],
  graphoria_queue_messages_consumed_total: ["broker", "consumer", "outcome", "queue"],
};

export const stringAttribute = (span: FakeSpan, key: string) =>
  span.attributes[key] as string | undefined;

export type LogRecord = {
  level: "trace" | "debug" | "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
};

// pino's call shapes: log.warn("msg") and log.warn({ ...fields }, "msg").
const recordingLogger = (logs: LogRecord[], bindings: Record<string, unknown>) => {
  const at =
    (level: LogRecord["level"]) =>
    (first?: unknown, second?: unknown): void => {
      const [fields, msg] = typeof first === "string" ? [{}, first] : [first ?? {}, second ?? ""];
      logs.push({ level, msg: String(msg), fields: { ...bindings, ...(fields as object) } });
    };
  return {
    child: (more: Record<string, unknown>) => recordingLogger(logs, { ...bindings, ...more }),
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
};

export const createFakeContext = () => {
  const spans: FakeSpan[] = [];
  const counters = new Map<string, number>();
  const logs: LogRecord[] = [];
  const events: { key: string; payload: { data: unknown } }[] = [];

  const startSpan: QueueRuntimeContext["startSpan"] = (name, options) => {
    const span: FakeSpan = {
      name,
      kind: options?.kind ? KIND_CODE[options.kind] : KIND_CODE.internal,
      attributes: options?.attributes ?? {},
      status: { code: STATUS_CODE.unset },
    };
    spans.push(span);
    return {
      setStatus: (status: "unset" | "ok" | "error") => {
        span.status.code = STATUS_CODE[status];
      },
      end: () => undefined,
    } as unknown as ReturnType<QueueRuntimeContext["startSpan"]>;
  };

  const incMetric: QueueRuntimeContext["incMetric"] = (metric, labels, value = 1) => {
    const ordered = (LABEL_ORDER[metric] ?? Object.keys(labels)).map((key) => [
      key,
      labels[key] ?? "",
    ]);
    const key = JSON.stringify([metric, ordered]);
    counters.set(key, (counters.get(key) ?? 0) + value);
  };

  const registry = {
    render: () =>
      [...counters.entries()]
        .map(([key, count]) => {
          const [metric, labels] = JSON.parse(key) as [string, [string, string][]];
          return `${metric}{${labels.map(([k, v]) => `${k}="${v}"`).join(",")}} ${count}`;
        })
        .join("\n"),
  };

  const context: QueueRuntimeContext = {
    emitSubscriptionEvent: (key, payload) => {
      events.push({ key, payload });
    },
    cache: { invalidate: async () => true },
    logger: ((component: string) =>
      recordingLogger(logs, { component })) as unknown as QueueRuntimeContext["logger"],
    incMetric,
    startSpan,
  };

  return { context, registry, spans: async () => spans, logs, events };
};
