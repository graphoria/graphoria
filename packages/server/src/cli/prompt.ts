import { emitKeypressEvents } from "node:readline";

export type Choice<T> = { value: T; label: string; hint?: string };

export type Ask = (question: string, fallback: string) => string | null | Promise<string | null>;
export type Say = (line: string) => void;
export type Select = <T>(
  question: string,
  choices: readonly Choice<T>[],
  initial: number,
) => T | Promise<T>;
export type MultiSelect = <T>(
  question: string,
  choices: readonly Choice<T>[],
  initial: readonly T[],
) => T[] | Promise<T[]>;

export type MenuState = { active: number; selected: readonly number[] };
type Key = { name?: string; ctrl?: boolean };
export type MenuResult = { state: MenuState; done: boolean } | "cancel";

export const reduceMenu = (
  state: MenuState,
  key: Key,
  count: number,
  multi: boolean,
): MenuResult => {
  if (key.ctrl && key.name === "c") return "cancel";
  if (key.name === "up") {
    return { state: { ...state, active: (state.active - 1 + count) % count }, done: false };
  }
  if (key.name === "down") {
    return { state: { ...state, active: (state.active + 1) % count }, done: false };
  }
  if (key.name === "space" && multi) {
    const selected = state.selected.includes(state.active)
      ? state.selected.filter((index) => index !== state.active)
      : [...state.selected, state.active];
    return { state: { ...state, selected }, done: false };
  }
  if (key.name === "enter" || key.name === "return") {
    return { state, done: true };
  }
  return { state, done: false };
};

export type LineResult = { line: string; echo: string; done: boolean } | "cancel";

export const reduceLine = (line: string, text: string | undefined, key: Key): LineResult => {
  if (key.ctrl && key.name === "c") return "cancel";
  if (key.name === "enter" || key.name === "return") return { line, echo: "", done: true };
  if (key.name === "backspace") {
    return line
      ? { line: Array.from(line).slice(0, -1).join(""), echo: "\b \b", done: false }
      : { line, echo: "", done: false };
  }
  if (key.ctrl || !text || text < " ") return { line, echo: "", done: false };
  return { line: line + text, echo: text, done: false };
};

type RawStdin = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };

const stdin = process.stdin as RawStdin;
const stdout = process.stdout;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const up = (lines: number) => `\x1b[${lines}A`;
const deleteLines = (lines: number) => `\x1b[${lines}M`;

export const interactive = (): boolean =>
  Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === "function");

const fit = (line: string): string => line.slice(0, Math.max(20, (stdout.columns ?? 80) - 1));

type OnKey = (text: string | undefined, key: Key) => void;

let keysReady = false;
let current: OnKey | undefined;
// A read can carry keys past the one that answers a question (a paste, fast typing): they wait
// here for the next question instead of reaching no one.
const pending: [text: string | undefined, key: Key][] = [];

const installKeypress = () => {
  if (keysReady) return;
  emitKeypressEvents(stdin);
  stdin.on("keypress", (text: string | undefined, key: Key) => {
    if (current) current(text, key);
    else pending.push([text, key]);
  });
  keysReady = true;
};

/**
 * Puts the terminal in raw mode, so an interrupt arrives as a keypress the
 * prompt can answer instead of a SIGINT that kills the process mid-question.
 *
 * Call this before anything is painted. The driver echoes `^C` and raises the
 * signal while the terminal is still cooked, and a signal takes the process out
 * without the cursor restore — leaving the user's terminal without a cursor.
 * A key pressed in the gap between this and `listen` waits in `pending`.
 */
const takeTerminal = () => {
  installKeypress();
  stdin.setRawMode?.(true);
  stdin.resume();
};

const listen = (onKey: OnKey) => {
  takeTerminal();
  current = onKey;
  while (current === onKey && pending.length > 0) onKey(...pending.shift()!);
};

const release = () => {
  current = undefined;
  stdin.setRawMode?.(false);
  stdin.pause();
};

const menuLines = <T>(
  question: string,
  choices: readonly Choice<T>[],
  state: MenuState,
  multi: boolean,
): string[] => [
  `? ${question}${multi ? " (space to toggle, enter to confirm)" : ""}`,
  ...choices.map((choice, index) => {
    const pointer = index === state.active ? ">" : " ";
    const box = multi ? (state.selected.includes(index) ? "[x] " : "[ ] ") : "";
    const hint = choice.hint ? ` - ${choice.hint}` : "";
    return `  ${pointer} ${box}${choice.label}${hint}`;
  }),
];

export const finishLines = <T>(
  question: string,
  choices: readonly Choice<T>[],
  indices: readonly number[],
  drawn: number,
): string => {
  const labels = indices.map((index) => choices[index].label);
  const summary = `? ${question} ${labels.length === 0 ? "none" : labels.join(", ")}\n`;
  if (drawn === 0) return summary;
  // Delete the menu first: a summary wider than the terminal wraps onto the line below it.
  return `${up(drawn)}${deleteLines(drawn)}${summary}`;
};

const run = <T>(
  question: string,
  choices: readonly Choice<T>[],
  active: number,
  multi: boolean,
  initial: readonly number[],
): Promise<number[]> => {
  let state: MenuState = { active, selected: initial };
  let drawn = 0;

  stdout.write(HIDE_CURSOR);

  const render = () => {
    const next = menuLines(question, choices, state, multi);
    if (drawn > 0) stdout.write(up(drawn));
    for (const line of next) stdout.write(`${CLEAR_LINE}${fit(line)}\n`);
    drawn = next.length;
  };

  return new Promise<number[]>((resolve) => {
    let cleaned = false;

    // `process.exit` truncates a write that has not reached the terminal, and
    // the cursor restore is the one write that must not be lost: the terminal
    // stays broken for the rest of the session. The callback runs once the
    // restore has been handed to the stream, so `then` is where exit belongs.
    const cleanup = (then?: () => void) => {
      if (cleaned) return;
      cleaned = true;
      release();
      process.off("exit", cleanup);
      stdout.write(SHOW_CURSOR, then);
    };

    const finish = (indices: readonly number[]) => {
      cleanup();
      stdout.write(finishLines(question, choices, indices, drawn));
      resolve([...indices]);
    };

    const onKey = (_text: string | undefined, key: Key) => {
      const result = reduceMenu(state, key, choices.length, multi);
      if (result === "cancel") {
        cleanup(() => process.exit(130));
        return;
      }
      const previous = state;
      state = result.state;
      if (result.done) finish(multi ? state.selected : [state.active]);
      else if (state !== previous) render();
    };

    process.once("exit", () => cleanup());
    takeTerminal();
    stdout.write(HIDE_CURSOR);
    render();
    listen(onKey);
  });
};

export const ask = (question: string, fallback: string): Promise<string> =>
  new Promise((resolve) => {
    let line = "";
    // Raw mode first, then the question: a Ctrl+C answered by the driver instead
    // of the prompt leaves the line unterminated on screen.
    takeTerminal();
    stdout.write(`${question} [${fallback}] `);
    listen((text, key) => {
      const result = reduceLine(line, text, key);
      if (result === "cancel") {
        release();
        stdout.write("\n", () => process.exit(130));
        return;
      }
      line = result.line;
      if (result.done) {
        release();
        stdout.write("\n");
        resolve(line);
      } else if (result.echo) stdout.write(result.echo);
    });
  });

export async function select<T>(
  question: string,
  choices: readonly Choice<T>[],
  initial: number,
): Promise<T> {
  if (choices.length === 0) throw new Error("select: no choices");
  const [index] = await run(question, choices, initial, false, []);
  return choices[index].value;
}

export async function multiSelect<T>(
  question: string,
  choices: readonly Choice<T>[],
  initial: readonly T[],
): Promise<T[]> {
  const selected = choices.flatMap((choice, index) =>
    initial.includes(choice.value) ? [index] : [],
  );
  if (choices.length === 0) return [];
  const indices = await run(question, choices, selected[0] ?? 0, true, selected);
  return indices.map((index) => choices[index].value);
}
