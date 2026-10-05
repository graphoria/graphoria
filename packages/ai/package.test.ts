import { describe, expect, it } from "bun:test";

import server from "../server/package.json";
import ai from "./package.json";

describe("@graphoria/ai", () => {
  it("pins the @graphoria/server of its own version", () => {
    expect(ai.version).toBe(server.version);
    expect(ai.peerDependencies["@graphoria/server"]).toBe(server.version);
  });

  it("is the optional @graphoria/ai peer of the server of its own version", () => {
    expect(server.peerDependencies["@graphoria/ai"]).toBe(ai.version);
    expect(server.peerDependenciesMeta["@graphoria/ai"].optional).toBe(true);
  });
});
