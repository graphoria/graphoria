import { describe, expect, it } from "bun:test";

import type { MenuState } from "./prompt";

import { finishLines, multiSelect, reduceMenu, select } from "./prompt";

const CHOICES = [
  { value: "pg", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "mssql", label: "SQL Server" },
];

const START: MenuState = { active: 0, selected: [] };

describe("reduceMenu", () => {
  it("moves down, wrapping at the end", () => {
    expect(reduceMenu(START, { name: "down" }, 3, false)).toEqual({
      state: { active: 1, selected: [] },
      done: false,
    });
    expect(reduceMenu({ active: 2, selected: [] }, { name: "down" }, 3, false)).toEqual({
      state: { active: 0, selected: [] },
      done: false,
    });
  });

  it("moves up, wrapping at the start", () => {
    expect(reduceMenu({ active: 1, selected: [] }, { name: "up" }, 3, false)).toEqual({
      state: { active: 0, selected: [] },
      done: false,
    });
    expect(reduceMenu(START, { name: "up" }, 3, false)).toEqual({
      state: { active: 2, selected: [] },
      done: false,
    });
  });

  it("finishes a single select on enter", () => {
    expect(reduceMenu({ active: 1, selected: [] }, { name: "enter" }, 3, false)).toEqual({
      state: { active: 1, selected: [] },
      done: true,
    });
  });

  it("toggles the active item of a multi-select on space", () => {
    expect(reduceMenu(START, { name: "space" }, 3, true)).toEqual({
      state: { active: 0, selected: [0] },
      done: false,
    });
    expect(reduceMenu({ active: 0, selected: [0] }, { name: "space" }, 3, true)).toEqual({
      state: { active: 0, selected: [] },
      done: false,
    });
    expect(reduceMenu({ active: 1, selected: [0] }, { name: "space" }, 3, true)).toEqual({
      state: { active: 1, selected: [0, 1] },
      done: false,
    });
  });

  it("ignores space in a single select", () => {
    expect(reduceMenu(START, { name: "space" }, 3, false)).toEqual({ state: START, done: false });
  });

  it("finishes a multi-select on enter", () => {
    expect(reduceMenu({ active: 1, selected: [0, 2] }, { name: "enter" }, 3, true)).toEqual({
      state: { active: 1, selected: [0, 2] },
      done: true,
    });
  });

  it("cancels on ctrl+c", () => {
    expect(reduceMenu(START, { name: "c", ctrl: true }, 3, true)).toBe("cancel");
  });

  it("leaves the state alone on any other key", () => {
    expect(reduceMenu(START, { name: "x" }, 3, true)).toEqual({ state: START, done: false });
    expect(reduceMenu(START, {}, 3, false)).toEqual({ state: START, done: false });
  });
});

describe("finishLines", () => {
  it("deletes the menu, then writes one summary line in its place", () => {
    expect(finishLines("Database engine", CHOICES, [1], 4)).toBe(
      "\x1b[4A\x1b[4M? Database engine MySQL\n",
    );
  });

  it("prints only the summary when nothing was drawn", () => {
    expect(finishLines("Select extras", CHOICES, [], 0)).toBe("? Select extras none\n");
  });
});

describe("select", () => {
  it("throws when there is nothing to choose", async () => {
    await expect(select("Database engine", [], 0)).rejects.toThrow("select: no choices");
  });
});

describe("multiSelect", () => {
  it("returns nothing when there is nothing to choose", async () => {
    expect(await multiSelect("Extras", [], [])).toEqual([]);
  });
});
