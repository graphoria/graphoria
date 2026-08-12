import { describe, expect, it } from "bun:test";

import { parseDurationToMs, parseDurationToSeconds, toPasetoDuration } from "./duration";

describe("parseDurationToSeconds", () => {
  it("parses seconds", () => expect(parseDurationToSeconds("30s")).toBe(30));
  it("parses minutes", () => expect(parseDurationToSeconds("5m")).toBe(300));
  it("parses hours", () => expect(parseDurationToSeconds("1h")).toBe(3600));
  it("parses days", () => expect(parseDurationToSeconds("7d")).toBe(604800));
  it("defaults to value when no recognized unit", () =>
    expect(parseDurationToSeconds("60")).toBe(6));
});

describe("parseDurationToMs", () => {
  it("converts to milliseconds", () => expect(parseDurationToMs("5m")).toBe(300000));
});

describe("toPasetoDuration", () => {
  it("converts seconds", () => expect(toPasetoDuration("30s")).toBe("30 seconds"));
  it("converts single second", () => expect(toPasetoDuration("1s")).toBe("1 second"));
  it("converts minutes", () => expect(toPasetoDuration("5m")).toBe("5 minutes"));
  it("converts single minute", () => expect(toPasetoDuration("1m")).toBe("1 minute"));
  it("converts hours", () => expect(toPasetoDuration("2h")).toBe("2 hours"));
  it("converts single hour", () => expect(toPasetoDuration("1h")).toBe("1 hour"));
  it("converts days", () => expect(toPasetoDuration("7d")).toBe("7 days"));
  it("converts single day", () => expect(toPasetoDuration("1d")).toBe("1 day"));
  it("defaults unknown unit to seconds", () => expect(toPasetoDuration("60")).toBe("6 seconds"));
});
