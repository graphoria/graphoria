import { describe, expect, it } from "bun:test";

import { cron } from "./cronHelper";

describe("cron helper", () => {
  it("preserves the onTick callback through validation", () => {
    const onTick = () => {};
    const job = cron({
      name: "cleanup",
      pattern: "0 0 * * *",
      onTick,
    });

    expect(job.onTick).toBe(onTick);
  });

  it("preserves catchErrors and context", () => {
    const job = cron({
      name: "cleanup",
      pattern: "0 0 * * *",
      catchErrors: false,
      context: { source: "test" },
    });

    expect(job.catchErrors).toBe(false);
    expect(job.context).toEqual({ source: "test" });
  });
});
