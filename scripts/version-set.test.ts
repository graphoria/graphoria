import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const manifest = (fields: Record<string, unknown>) => `${JSON.stringify(fields, null, 2)}\n`;

describe("version:set", () => {
  it("moves every version and every @graphoria pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphoria-version-set-"));
    roots.push(root);
    const write = (path: string, fields: Record<string, unknown>) =>
      Bun.write(join(root, path), manifest(fields));
    const read = async (path: string) => JSON.parse(await Bun.file(join(root, path)).text());

    await Bun.write(
      join(root, "scripts/version-set.ts"),
      Bun.file(join(import.meta.dir, "version-set.ts")),
    );
    await write("package.json", { name: "@graphoria/monorepo", version: "0.6.0" });
    await write("packages/server/package.json", {
      name: "@graphoria/server",
      version: "0.6.0",
      peerDependencies: { "@graphoria/queues": "0.6.0", typescript: "^6.0.0" },
      peerDependenciesMeta: {
        "@graphoria/queues": { optional: true },
        typescript: { optional: true },
      },
    });
    await write("packages/queues/package.json", {
      name: "@graphoria/queues",
      version: "0.6.0",
      peerDependencies: { "@graphoria/server": "0.6.0" },
    });
    await write("packages/graphoria/package.json", {
      name: "graphoria",
      version: "0.6.0",
      dependencies: { "@graphoria/server": "0.6.0" },
    });

    const result = Bun.spawnSync(["bun", join(root, "scripts/version-set.ts"), "0.7.0"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect((await read("package.json")).version).toBe("0.7.0");

    const server = await read("packages/server/package.json");
    expect(server.version).toBe("0.7.0");
    expect(server.peerDependencies).toEqual({ "@graphoria/queues": "0.7.0", typescript: "^6.0.0" });

    const queues = await read("packages/queues/package.json");
    expect(queues.version).toBe("0.7.0");
    expect(queues.peerDependencies).toEqual({ "@graphoria/server": "0.7.0" });

    const wrapper = await read("packages/graphoria/package.json");
    expect(wrapper.version).toBe("0.7.0");
    expect(wrapper.dependencies).toEqual({ "@graphoria/server": "0.7.0" });
  });
});
