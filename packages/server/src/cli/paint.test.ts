import { describe, expect, it } from "bun:test";

import { COLOR_PAINT, PLAIN_PAINT, paintFor } from "./paint";

describe("paintFor", () => {
  it.each([
    {
      what: "a terminal whose TERM takes color",
      isTTY: true,
      ansi: "\x1b[97m",
      forced: false,
      want: COLOR_PAINT,
    },
    { what: "a pipe", isTTY: undefined, ansi: "\x1b[97m", forced: false, want: PLAIN_PAINT },
    {
      what: "a pipe under FORCE_COLOR",
      isTTY: undefined,
      ansi: "\x1b[97m",
      forced: true,
      want: COLOR_PAINT,
    },
    {
      what: "a pipe under FORCE_COLOR=0",
      isTTY: undefined,
      ansi: "",
      forced: true,
      want: PLAIN_PAINT,
    },
    {
      what: "a terminal under NO_COLOR, TERM=dumb or no TERM",
      isTTY: true,
      ansi: "",
      forced: false,
      want: PLAIN_PAINT,
    },
  ])("picks the paint for $what", ({ isTTY, ansi, forced, want }) => {
    expect(paintFor({ isTTY }, ansi, forced)).toBe(want);
  });
});

describe("COLOR_PAINT", () => {
  it("colors the text without changing it", () => {
    for (const color of Object.values(COLOR_PAINT)) {
      expect(Bun.stripANSI(color("text"))).toBe("text");
    }
  });

  it("paints Graphoria's marks in its own colors, at the depth Bun.color finds", () => {
    const script = `const { COLOR_PAINT } = await import(${JSON.stringify(`${import.meta.dir}/paint.ts`)});
console.log(JSON.stringify([COLOR_PAINT.accent("a"), COLOR_PAINT.success("s")]));`;
    const paintUnder = (env: Record<string, string>) =>
      JSON.parse(
        Bun.spawnSync([process.execPath, "-e", script], {
          env: { PATH: process.env.PATH!, ...env },
        }).stdout.toString(),
      );

    expect(paintUnder({ TERM: "xterm-256color", COLORTERM: "truecolor" })).toEqual([
      "\x1b[38;2;18;163;191ma\x1b[39m",
      "\x1b[38;2;20;179;137ms\x1b[39m",
    ]);
    expect(paintUnder({ FORCE_COLOR: "1" })).toEqual(["\x1b[36ma\x1b[39m", "\x1b[32ms\x1b[39m"]);
  });
});
