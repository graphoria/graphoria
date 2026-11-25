export type Paint = Record<
  "code" | "url" | "name" | "secret" | "warning" | "accent" | "success" | "failure" | "dim",
  (text: string) => string
>;

const plain = (text: string) => text;

export const PLAIN_PAINT: Paint = {
  code: plain,
  url: plain,
  name: plain,
  secret: plain,
  warning: plain,
  accent: plain,
  success: plain,
  failure: plain,
  dim: plain,
};

const tint = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[39m`;

// Graphoria's mark colors, for the marks only: Bun.color writes them at the terminal's depth, down
// to the nearest of the 16 colors (cyan, green).
const brand = (hex: string) => {
  const open = Bun.color(hex, "ansi");
  return open ? (text: string) => `${open}${text}\x1b[39m` : plain;
};

// The text gets 16-color codes (36 cyan, 94 bright blue, 33 yellow), not 256 or truecolor: the
// terminal's theme then chooses shades its background reads. Bun's console.error prints red by
// itself on a terminal; a ✗ on stdout needs its own (31).
export const COLOR_PAINT: Paint = {
  code: tint(36),
  url: tint(94),
  name: (text) => `\x1b[1m${text}\x1b[22m`,
  secret: tint(33),
  warning: tint(33),
  accent: brand("#12A3BF"),
  success: brand("#14B389"),
  failure: tint(31),
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
};

// Bun.color's "ansi" weighs TERM, NO_COLOR and FORCE_COLOR but never the stream, and
// Bun.enableANSIColors holds while either stdout or stderr is a terminal: each stream decides alone.
export const paintFor = (
  stream: { isTTY?: boolean },
  ansi = Bun.color("white", "ansi"),
  forced = process.env.FORCE_COLOR !== undefined,
): Paint => (ansi && (stream.isTTY || forced) ? COLOR_PAINT : PLAIN_PAINT);
