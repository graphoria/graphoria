import { describe, expect, it } from "bun:test";

import server from "../server/package.json";
import queues from "./package.json";

describe("@graphoria/queues", () => {
  it("pins the @graphoria/server of its own version", () => {
    expect(queues.version).toBe(server.version);
    expect(queues.peerDependencies["@graphoria/server"]).toBe(server.version);
  });

  it("is the optional @graphoria/queues peer of the server of its own version", () => {
    expect(server.peerDependencies["@graphoria/queues"]).toBe(queues.version);
    expect(server.peerDependenciesMeta["@graphoria/queues"].optional).toBe(true);
  });
});
