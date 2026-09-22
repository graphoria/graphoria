import { configureTracing, createTracer, setTracer } from "../observability/tracing";

/** A span as it appears in the OTLP payload, which is the only shape a collector sees. */
export type RecordedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number; message?: string };
};

const OFF = {
  enabled: false,
  endpoint: "http://collector:4318",
  headers: "",
  serviceName: "graphoria",
  sampleRatio: 1,
};

/**
 * Installs a real tracer whose transport collects payloads instead of posting
 * them, which is the same boundary the production exporter writes to. Call
 * `restore` in an `afterEach` — it uninstalls the tracer and turns tracing off.
 */
export const installSpanSink = () => {
  const bodies: string[] = [];

  const tracer = createTracer({
    endpoint: "http://collector:4318",
    serviceName: "graphoria",
    serviceVersion: "test",
    exportIntervalMs: 0,
    send: async (_url, init) => {
      bodies.push(init.body);
    },
  });

  setTracer(tracer);
  configureTracing({ ...OFF, enabled: true });

  return {
    spans: async (): Promise<RecordedSpan[]> => {
      await tracer.flush();
      return bodies.flatMap((body) =>
        (
          JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: RecordedSpan[] }[] }[] }
        ).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
      );
    },
    restore: () => {
      setTracer(null);
      configureTracing(OFF);
    },
  };
};

export const attributeOf = (span: RecordedSpan, key: string) =>
  span.attributes.find((entry) => entry.key === key)?.value;

export const stringAttribute = (span: RecordedSpan, key: string) =>
  (attributeOf(span, key) as { stringValue?: string } | undefined)?.stringValue;
