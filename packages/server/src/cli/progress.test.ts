import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Step } from "./progress";

import { PLAIN_PAINT } from "./paint";
import { SPINNER, formatDuration, runSteps } from "./progress";

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [412.4, "412ms"],
    [999.4, "999ms"],
    [999.6, "1.0s"],
    [4210, "4.2s"],
    [59_940, "59.9s"],
    [59_960, "1m 0s"],
    [72_400, "1m 12s"],
  ])("prints %d ms as %s", (ms, want) => {
    expect(formatDuration(ms)).toBe(want);
  });
});

describe("runSteps", () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

  const sh = (doing: string, done: string, script: string): Step => ({
    doing,
    done,
    command: ["sh", "-c", script],
  });

  const run = async (steps: Step[], { isTTY = false, columns = 60 } = {}) => {
    const cwd = await mkdtemp(join(tmpdir(), "graphoria-steps-"));
    dirs.push(cwd);
    const writes: string[] = [];
    const errors: Uint8Array[] = [];
    const failed = await runSteps(steps, {
      cwd,
      out: { isTTY, columns, write: (text: string) => writes.push(text) },
      errors: { write: (chunk: Uint8Array) => errors.push(chunk) },
      paint: PLAIN_PAINT,
    });
    return { cwd, failed, writes, errors: Buffer.concat(errors).toString() };
  };

  it("runs the steps in turn, a line apiece, holding their output back", async () => {
    const { failed, writes, errors } = await run([
      sh("Saying hi", "Said hi", "echo hi"),
      sh("Saying bye", "Said bye", "echo bye >&2"),
    ]);

    expect(failed).toBeUndefined();
    expect(writes.join("")).toMatch(
      /^Saying hi…\n✓ Said hi {3}\S+\nSaying bye…\n✓ Said bye {2}\S+\n$/,
    );
    expect(errors).toBe("");
  });

  it("stops at a step that fails, writing its output to errors", async () => {
    const steps = [
      sh("Failing", "Failed", "echo out; echo err >&2; exit 3"),
      sh("Marking", "Marked", "touch marker"),
    ];

    const { cwd, failed, writes, errors } = await run(steps);

    expect(failed).toBe(steps[0]);
    expect(writes.join("")).toMatch(/^Failing…\n✗ Failing failed {2}\S+\n$/);
    expect(errors).toContain("out\n");
    expect(errors).toContain("err\n");
    expect(await Bun.file(join(cwd, "marker")).exists()).toBe(false);
  });

  it("fails a step whose command is not on the PATH, saying why", async () => {
    const step = { doing: "Calling", done: "Called", command: ["graphoria-no-such-command"] };

    const { failed, errors } = await run([step]);

    expect(failed).toBe(step);
    expect(errors).toContain('Executable not found in $PATH: "graphoria-no-such-command"');
  });

  it("draws a spinner on a terminal, short of its width, then the step's line", async () => {
    const { writes } = await run([sh("x".repeat(60), "Slept", "sleep 0.3")], {
      isTTY: true,
      columns: 30,
    });

    const frames = writes.slice(0, -1);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0]).toStartWith(`\r\x1b[2K${SPINNER[0]} xxx`);
    expect(frames[1]).toStartWith(`\r\x1b[2K${SPINNER[1]} xxx`);
    for (const frame of frames) {
      expect(Bun.stringWidth(frame.slice("\r\x1b[2K".length))).toBeLessThanOrEqual(29);
      expect(frame).not.toContain("\n");
    }
    expect(writes.at(-1)).toStartWith("\r\x1b[2K✓ Slept  ");
    expect(writes.at(-1)).toMatch(/✓ Slept {2}\S+\n$/);
  });

  // In a process of its own: an interrupt exits it.
  const stepsScript = (command: string[]) => `
const { runSteps } = await import(${JSON.stringify(join(import.meta.dir, "progress.ts"))});
const { PLAIN_PAINT } = await import(${JSON.stringify(join(import.meta.dir, "paint.ts"))});
const step = { doing: "Waiting", done: "Waited", command: ${JSON.stringify(command)} };
await runSteps([step], { cwd: process.cwd(), out: process.stdout, errors: process.stderr, paint: PLAIN_PAINT });
console.log("after");
`;

  it("stops at Ctrl+C on a terminal, clearing the spinner for a line that says so", async () => {
    let output = "";
    const decoder = new TextDecoder();
    const proc = Bun.spawn([process.execPath, "-e", stepsScript(["sleep", "5"])], {
      terminal: {
        cols: 60,
        rows: 10,
        data: (_terminal, chunk) => {
          output += decoder.decode(chunk, { stream: true });
        },
      },
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!output.includes("Waiting…")) {
        if (Date.now() > deadline) throw new Error(`no spinner in:\n${output}`);
        await Bun.sleep(20);
      }
      proc.terminal!.write("\x03");

      expect(await proc.exited).toBe(130);
    } finally {
      proc.kill();
      proc.terminal!.close();
    }
    expect(output).toContain("\r\x1b[2K✗ Waiting interrupted  ");
    expect(output).toMatch(/✗ Waiting interrupted {2}\S+\r\n$/);
    expect(output).not.toContain("after");
  });

  it("stops, saying so, when a step's command dies of an interrupt", () => {
    const result = Bun.spawnSync([
      process.execPath,
      "-e",
      stepsScript(["sh", "-c", "kill -INT $$"]),
    ]);

    expect(result.exitCode).toBe(130);
    expect(result.stdout.toString()).toMatch(/^Waiting…\n✗ Waiting interrupted {2}\S+\n$/);
  });
});
