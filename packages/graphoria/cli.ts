#!/usr/bin/env bun
import { dirname, join } from "node:path";

// The CLI ships in @graphoria/server; this package only gives it the unscoped
// name, so `bunx graphoria init` works in an empty directory.
const server = dirname(Bun.resolveSync("@graphoria/server/package.json", import.meta.dir));

await import(join(server, "cli.ts"));
