import type { Paint } from "./paint";

export type Step = {
  /** The line while the step runs. */
  doing: string;
  /** The line once it succeeds. */
  done: string;
  command: string[];
};

type Out = { isTTY?: boolean; columns?: number; write: (text: string) => unknown };
type Errors = { write: (chunk: Uint8Array) => unknown };

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
const CLEAR_LINE = "\r\x1b[2K";

export const formatDuration = (ms: number): string => {
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const spawn = (command: string[], cwd: string) => {
  try {
    return Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    // Bun.spawn throws when the command is not on the PATH: docker, without Docker.
    return error instanceof Error ? error : new Error(String(error));
  }
};

const run = async (command: string[], cwd: string) => {
  const output: Uint8Array[] = [];
  const proc = spawn(command, cwd);
  if (proc instanceof Error) {
    output.push(new TextEncoder().encode(`${proc.message}\n`));
    return { ok: false, output };
  }
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output.push(chunk);
  };
  const [code] = await Promise.all([proc.exited, collect(proc.stdout), collect(proc.stderr)]);
  return { ok: code === 0, output };
};

/**
 * Runs the steps in turn, a line apiece: a spinner while one runs on a terminal, its name
 * elsewhere. A step's own output is held back, and written to `errors` only when the step fails,
 * which stops the rest. Returns the step that failed.
 */
export const runSteps = async (
  steps: readonly Step[],
  { cwd, out, errors, paint }: { cwd: string; out: Out; errors: Errors; paint: Paint },
): Promise<Step | undefined> => {
  const width = Math.max(0, ...steps.map(({ done }) => done.length));
  for (const step of steps) {
    const started = performance.now();
    const elapsed = () => formatDuration(performance.now() - started);
    let frame = 0;
    const draw = () => {
      const time = elapsed();
      // A line as wide as the terminal wraps, and \r then redraws only its last row.
      const room = Math.max(1, (out.columns ?? 80) - 4 - time.length);
      const label = `${step.doing}…`;
      const fitted = label.length > room ? `${label.slice(0, room - 1)}…` : label;
      const mark = paint.accent(SPINNER[frame++ % SPINNER.length]!);
      out.write(`${CLEAR_LINE}${mark} ${fitted} ${paint.dim(time)}`);
    };

    let timer: ReturnType<typeof setInterval> | undefined;
    if (out.isTTY) {
      draw();
      timer = setInterval(draw, FRAME_MS);
    } else {
      out.write(`${step.doing}…\n`);
    }
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(step.command, cwd);
    } finally {
      clearInterval(timer);
    }

    const time = paint.dim(elapsed());
    const clear = out.isTTY ? CLEAR_LINE : "";
    if (result.ok) {
      out.write(`${clear}${paint.success("✓")} ${step.done.padEnd(width)}  ${time}\n`);
      continue;
    }
    out.write(`${clear}${paint.failure("✗")} ${step.doing} failed  ${time}\n`);
    for (const chunk of result.output) errors.write(chunk);
    return step;
  }
  return undefined;
};
