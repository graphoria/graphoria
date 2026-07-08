# playgrounds

One Vite project, two playground apps, each built as a self-contained single HTML file into `packages/server/playgrounds/<name>/index.html`:

- `graphiql/` — GraphiQL UI (React). Reads `window.__GRAPHQL_URL__`, substituted into the HTML at serve time.
- `scalar/` — Scalar API reference (vanilla TS). Reads `window.__OPENAPI_URL__` and `window.__REST_PREFIX__`.

The app is selected with Vite's `--mode` flag; two separate build passes are required because `vite-plugin-singlefile` needs `inlineDynamicImports`, which Rollup forbids with multiple inputs.

## Scripts

- `bun run dev:graphiql` / `bun run dev:scalar` — Vite dev server for one app
- `bun run build` — typecheck + build both apps
- `bun run build:graphiql` / `bun run build:scalar` — typecheck + build one app
