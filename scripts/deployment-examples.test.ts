import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

const fences = (markdown: string, lang: string) =>
  [...markdown.matchAll(new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, "gm"))].map(
    (match) => match[1],
  );

const guide = read("docs/DEPLOYMENT.md");

describe("deployment examples match docs/DEPLOYMENT.md", () => {
  it("deploy-kubernetes/base holds the guide's YAML blocks unchanged", () => {
    expect(fences(guide, "yaml")).toEqual([
      read("examples/deploy-kubernetes/base/graphoria.yaml"),
      read("examples/deploy-kubernetes/base/envoy-gateway.yaml"),
    ]);
  });

  it("deploy-caddy's Caddyfile is the guide's, with the site address from SITE_ADDRESS", () => {
    const siteFromEnv = (caddyfile: string) =>
      caddyfile.replace(/^api\.example\.com \{$/m, () => "{$SITE_ADDRESS:localhost} {");

    expect(fences(guide, "caddyfile").map(siteFromEnv)).toEqual([
      read("examples/deploy-caddy/Caddyfile"),
    ]);
  });
});
