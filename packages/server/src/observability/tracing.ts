import { AsyncLocalStorage } from "node:async_hooks";

import type { Logger } from "pino";

import { version } from "../../package.json";
import { logger } from "../logging";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

export type SpanStatus = "unset" | "ok" | "error";

export type AttributeValue = string | number | boolean;

export type Attributes = Record<string, AttributeValue | undefined>;

/** What rides in the async context: three scalars, never the span itself. */
export type SpanContext = { traceId: string; spanId: string; sampled: boolean };

export type SpanOptions = {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Overrides the active context — the inbound `traceparent`, or a deliberate root. */
  parent?: SpanContext | null;
};

export type Span = {
  readonly context: SpanContext;
  setAttribute(key: string, value: AttributeValue | undefined): void;
  setStatus(status: SpanStatus, message?: string): void;
  recordError(error: unknown): void;
  end(): void;
};

export type FinishedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attributes;
  status: SpanStatus;
  statusMessage?: string;
};

export type Tracer = {
  startSpan(name: string, options?: SpanOptions): Span;
  /** Runs `fn` with `span` active, ends it, and marks it errored if `fn` throws. */
  withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T>;
  active(): SpanContext | undefined;
  flush(): Promise<void>;
};

export type TracerOptions = {
  endpoint: string;
  /** `k=v,k2=v2`, sent on every export — an API key for a hosted collector. */
  headers?: string;
  serviceName: string;
  serviceVersion: string;
  sampleRatio?: number;
  maxBatch?: number;
  maxQueue?: number;
  /** `0` starts no timer, which is how a test drives the exporter by hand. */
  exportIntervalMs?: number;
  /** Test seam: where an export failure and a queue overflow are reported. */
  log?: Pick<Logger, "warn">;
  /** Test seam: the transport. Production POSTs with `fetch`. */
  send?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<void>;
};

const MAX_BATCH = 512;
const MAX_QUEUE = 2048;
const EXPORT_INTERVAL_MS = 5000;

const KIND_CODES: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

const STATUS_CODES: Record<SpanStatus, number> = { unset: 0, ok: 1, error: 2 };

const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// A span is minted per statement, so the id path is on the request's critical
// path: a lookup table beats formatting each byte.
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

const hex = (bytes: number) => {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  let id = "";
  for (let index = 0; index < bytes; index++) id += HEX[buffer[index]!];
  return id;
};

// An all-zero id is invalid per the W3C spec and a collector rejects the span,
// so the (vanishing) draw is re-rolled rather than exported.
const newTraceId = () => {
  let id = hex(16);
  while (id === ZERO_TRACE_ID) id = hex(16);
  return id;
};

const newSpanId = () => {
  let id = hex(8);
  while (id === ZERO_SPAN_ID) id = hex(8);
  return id;
};

export const parseTraceparent = (header: string | null | undefined): SpanContext | undefined => {
  if (!header) return undefined;
  const match = TRACEPARENT.exec(header);
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
};

export const formatTraceparent = (context: SpanContext): string =>
  `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;

const parseHeaders = (headers: string): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const entry of headers.split(",")) {
    const index = entry.indexOf("=");
    if (index <= 0) continue;
    const key = entry.slice(0, index).trim();
    if (key) parsed[key] = entry.slice(index + 1).trim();
  }
  return parsed;
};

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

const renderAttributes = (attributes: Attributes) =>
  Object.entries(attributes).flatMap<{ key: string; value: AnyValue }>(([key, value]) => {
    if (value === undefined) return [];
    if (typeof value === "string") return [{ key, value: { stringValue: value } }];
    if (typeof value === "boolean") return [{ key, value: { boolValue: value } }];
    // OTLP/JSON carries an int64 as a string; a fractional number is a double.
    return [
      {
        key,
        value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
      },
    ];
  });

const renderSpan = (span: FinishedSpan) => ({
  traceId: span.traceId,
  spanId: span.spanId,
  ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
  name: span.name,
  kind: KIND_CODES[span.kind],
  startTimeUnixNano: span.startTimeUnixNano,
  endTimeUnixNano: span.endTimeUnixNano,
  attributes: renderAttributes(span.attributes),
  status: {
    code: STATUS_CODES[span.status],
    ...(span.statusMessage ? { message: span.statusMessage } : {}),
  },
});

const renderPayload = (spans: FinishedSpan[], serviceName: string, serviceVersion: string) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: serviceName } },
          { key: "service.version", value: { stringValue: serviceVersion } },
        ],
      },
      scopeSpans: [{ scope: { name: "graphoria" }, spans: spans.map(renderSpan) }],
    },
  ],
});

const defaultSend: NonNullable<TracerOptions["send"]> = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`collector answered HTTP ${response.status}`);
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One async context for every tracer in the process. It holds three scalars
 * rather than the span, so a retained context cannot pin a finished span's
 * attributes in memory.
 */
const store = new AsyncLocalStorage<SpanContext>();

/**
 * A tracer with no dependencies: W3C ids, OTLP/HTTP JSON, and a bounded export
 * queue. Nothing here reads process state — everything it needs is closed over,
 * so it is unit-testable without booting a server.
 */
export const createTracer = ({
  endpoint,
  headers = "",
  serviceName,
  serviceVersion,
  sampleRatio = 1,
  maxBatch = MAX_BATCH,
  maxQueue = MAX_QUEUE,
  exportIntervalMs = EXPORT_INTERVAL_MS,
  send = defaultSend,
  log = logger("tracing"),
}: TracerOptions): Tracer => {
  const url = `${endpoint.replace(/\/+$/, "")}/v1/traces`;
  const exportHeaders = { "content-type": "application/json", ...parseHeaders(headers) };

  let queue: FinishedSpan[] = [];
  let dropped = 0;

  const post = async (batch: FinishedSpan[]) => {
    try {
      await send(url, {
        method: "POST",
        headers: exportHeaders,
        body: JSON.stringify(renderPayload(batch, serviceName, serviceVersion)),
      });
    } catch (error) {
      // Dropped, never retried: an unbounded retry buffer is the failure mode
      // that turns an observability feature into the outage.
      log.warn({ err: error, spans: batch.length }, "span export failed");
    }
  };

  const flush = async () => {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    if (dropped > 0) {
      log.warn({ dropped }, "span queue full, oldest spans dropped");
      dropped = 0;
    }
    await post(batch);
  };

  if (exportIntervalMs > 0) {
    // Unref'd: there is no graceful-shutdown hook to clear it, and a live timer
    // would keep the process alive after the server closes.
    setInterval(() => void flush(), exportIntervalMs).unref();
  }

  const enqueue = (span: FinishedSpan) => {
    queue.push(span);
    if (queue.length > maxQueue) {
      dropped += queue.length - maxQueue;
      queue = queue.slice(queue.length - maxQueue);
    }
    if (queue.length >= maxBatch) void flush();
  };

  const shouldSample = (parent: SpanContext | undefined) => {
    if (parent) return parent.sampled;
    if (sampleRatio >= 1) return true;
    if (sampleRatio <= 0) return false;
    return Math.random() < sampleRatio;
  };

  const startSpan = (name: string, options: SpanOptions = {}): Span => {
    const parent = options.parent === undefined ? store.getStore() : (options.parent ?? undefined);
    const sampled = shouldSample(parent);
    const context: SpanContext = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      sampled,
    };

    // Wall clock for the start, monotonic for the length, so a span's duration
    // does not drift with the system clock.
    const startedAtNs = BigInt(Date.now()) * 1_000_000n;
    const startedAt = Bun.nanoseconds();
    const attributes: Attributes = { ...options.attributes };
    let status: SpanStatus = "unset";
    let statusMessage: string | undefined;
    let ended = false;

    return {
      context,
      setAttribute: (key, value) => {
        attributes[key] = value;
      },
      setStatus: (next, message) => {
        status = next;
        statusMessage = message;
      },
      recordError: (error) => {
        status = "error";
        statusMessage = errorMessage(error);
      },
      end: () => {
        if (ended) return;
        ended = true;
        if (!sampled) return;
        enqueue({
          traceId: context.traceId,
          spanId: context.spanId,
          ...(parent ? { parentSpanId: parent.spanId } : {}),
          name,
          kind: options.kind ?? "internal",
          startTimeUnixNano: String(startedAtNs),
          endTimeUnixNano: String(startedAtNs + BigInt(Bun.nanoseconds() - startedAt)),
          attributes,
          status,
          ...(statusMessage ? { statusMessage } : {}),
        });
      },
    };
  };

  return {
    startSpan,
    withSpan: async (name, options, fn) => {
      const span = startSpan(name, options);
      try {
        return await store.run(span.context, () => fn(span));
      } catch (error) {
        span.recordError(error);
        throw error;
      } finally {
        span.end();
      }
    },
    active: () => store.getStore(),
    flush,
  };
};

/**
 * Off until boot turns it on, so a handler or an executor used outside a booted
 * server records nothing and never enters the async store.
 */
let enabled = false;

let settings: Omit<TracerOptions, "serviceVersion"> = {
  endpoint: "http://localhost:4318",
  headers: "",
  serviceName: "graphoria",
  sampleRatio: 1,
};

let override: Tracer | null = null;
let instance: Tracer | null = null;

export const configureTracing = (next: {
  enabled: boolean;
  endpoint: string;
  headers: string;
  serviceName: string;
  sampleRatio: number;
}): void => {
  enabled = next.enabled;
  settings = {
    endpoint: next.endpoint,
    headers: next.headers,
    serviceName: next.serviceName,
    sampleRatio: next.sampleRatio,
  };
  instance = null;
};

/** Test seam: pass `null` to drop the process tracer and its queued spans. */
export const setTracer = (tracer: Tracer | null): void => {
  override = tracer;
  instance = null;
};

const tracer = (): Tracer => {
  if (override) return override;
  if (!instance) instance = createTracer({ ...settings, serviceVersion: version });
  return instance;
};

export const isTracingEnabled = (): boolean => enabled;

export const startSpan = (name: string, options?: SpanOptions): Span | undefined => {
  if (!enabled) return undefined;
  return tracer().startSpan(name, options);
};

export const withSpan = async <T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span | undefined) => T | Promise<T>,
): Promise<T> => {
  if (!enabled) return fn(undefined);
  return tracer().withSpan(name, options, fn);
};

/**
 * Runs `fn` with `span` active, leaving its lifetime to the caller. A span that
 * is never ended is never exported, which is how a websocket upgrade — a
 * request that is never answered — produces no span at all.
 */
export const withActiveSpan = <T>(span: Span | undefined, fn: () => T): T =>
  span ? store.run(span.context, fn) : fn();

export const activeSpanContext = (): SpanContext | undefined => {
  if (!enabled) return undefined;
  return tracer().active();
};

export const flushSpans = (): Promise<void> => {
  if (!enabled) return Promise.resolve();
  return tracer().flush();
};
