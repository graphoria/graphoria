#!/usr/bin/env bun
import { Glob } from "bun";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun run version:set <x.y.z>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;
const manifests = [
  "package.json",
  ...(await Array.fromAsync(new Glob("packages/*/package.json").scan({ cwd: root }))),
];

for (const relative of manifests.sort()) {
  const path = `${root}${relative}`;
  const source = await Bun.file(path).text();
  const field = /^(\s*"version":\s*)"[^"]*"/m;

  if (!field.test(source)) {
    console.error(`${relative}: no "version" field found`);
    process.exit(1);
  }

  // Rewrite the text rather than round-tripping through JSON, so key order,
  // indentation and trailing newline survive untouched.
  await Bun.write(path, source.replace(field, `$1"${version}"`));
  console.log(`${relative} -> ${version}`);
}
