# playgrounds

Three playground apps, each bundled by Bun into a self-contained single HTML file at `packages/server/playgrounds/<name>/index.html`:

- `graphiql/` — GraphiQL UI (React). Reads `window.__GRAPHQL_URL__`, substituted into the HTML at serve time.
- `scalar/` — Scalar API reference (vanilla TS). Reads `window.__OPENAPI_URL__` and `window.__REST_PREFIX__`.
- `console/` — admin console (React + Tailwind).

`build.ts` runs one `Bun.build` per app with `compile: true`, which inlines every script, stylesheet and asset into the HTML. Two plugins fill the gaps: `bun-plugin-tailwind` compiles the console's Tailwind, and `worker-inline.ts` bundles GraphiQL's Monaco workers into blob URLs — Bun's browser bundler doesn't follow `new Worker(new URL(...))`, and a single file has no sibling chunk to point at. `bunfig.toml` registers both for the dev server.

## Scripts

- `bun run dev:graphiql` / `dev:scalar` / `dev:console` — Bun dev server for one app
- `bun run build` — typecheck + build all three
- `bun run build:graphiql` / `build:scalar` / `build:console` — typecheck + build one app
