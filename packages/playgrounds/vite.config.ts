import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const APPS = ["graphiql", "scalar", "console"] as const;
type App = (typeof APPS)[number];

function inlinePublicFaviconPlugin(): Plugin {
  return {
    name: "inline-public-favicon",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const faviconPath = fileURLToPath(new URL("./public/favicon.svg", import.meta.url));
        const svg = readFileSync(faviconPath, "utf-8");
        const base64 = Buffer.from(svg, "utf-8").toString("base64");
        return html.replace(
          /href=("|')\/favicon\.svg\1/,
          `href="data:image/svg+xml;base64,${base64}"`,
        );
      },
    },
  };
}

// One package, two apps: `--mode graphiql | scalar` picks the app subdirectory
// as the Vite root. Two build passes are required because vite-plugin-singlefile
// needs inlineDynamicImports, which Rollup forbids with multiple inputs.
export default defineConfig(({ mode }) => {
  if (!APPS.includes(mode as App)) {
    throw new Error(`Unknown playground "${mode}" — use --mode ${APPS.join(" | --mode ")}`);
  }
  const app = mode as App;

  return {
    root: fileURLToPath(new URL(`./${app}`, import.meta.url)),
    plugins: [
      ...(app === "graphiql" || app === "console" ? [react()] : []),
      ...(app === "console" ? [tailwindcss()] : []),
      inlinePublicFaviconPlugin(),
      viteSingleFile(),
    ],
    publicDir: false,
    resolve:
      app === "graphiql"
        ? {
            alias: {
              "./setup-workers": fileURLToPath(
                new URL("./graphiql/src/setup-workers.inline.ts", import.meta.url),
              ),
            },
          }
        : undefined,
    build: {
      outDir: `../../server/playgrounds/${app}`,
      emptyOutDir: true,
      assetsInlineLimit: 100_000_000,
      chunkSizeWarningLimit: 100_000_000,
      cssCodeSplit: false,
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  };
});
