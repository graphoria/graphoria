import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalyzedConfiguration } from "../configuration/index.ts";

import { writeSchema } from "./writeSchema";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const rolesOf = (names: string[]) =>
  Object.fromEntries(
    names.map((name) => [name, { typeDefs: `type Query { ${name}: String }` }]),
  ) as unknown as AnalyzedConfiguration["roles"];

describe("writeSchema", () => {
  it("resolves once every role's schema is on disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "graphoria-write-schema-"));

    await writeSchema(rolesOf(["anonymous", "editor", "superadmin"]), dir);

    expect((await readdir(dir)).sort()).toEqual([
      "schema_anonymous.graphql",
      "schema_editor.graphql",
      "schema_superadmin.graphql",
    ]);
    expect(await Bun.file(join(dir, "schema_editor.graphql")).text()).toContain("editor: String");
  });
});
