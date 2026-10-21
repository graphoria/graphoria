import { GraphiQL } from "graphiql";
import { explorerPlugin } from "@graphiql/plugin-explorer";
import "graphiql/style.css";
import "@graphiql/plugin-explorer/style.css";
import { useAuthFetcher } from "./useAuthFetcher";
import TokenBanner from "./TokenBanner";

const url = window.__GRAPHQL_URL__;
const isConfigured = url && !url.startsWith("{{");
const initialQuery = new URLSearchParams(window.location.search).get("query") ?? undefined;

const explorer = explorerPlugin();

function App() {
  const fetcher = useAuthFetcher(isConfigured ? url : null);

  if (!isConfigured || !fetcher) {
    return (
      <div className="missing-endpoint">
        <h1>GraphiQL - Missing endpoint</h1>
        <p>
          No GraphQL URL configured. Replace <code>{"{{GRAPHQL_URL}}"}</code> in the served HTML
          before serving.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* `initialQuery`, not `defaultQuery`: a saved tab state would otherwise win. */}
      <GraphiQL fetcher={fetcher} plugins={[explorer]} initialQuery={initialQuery} />
      <TokenBanner />
    </>
  );
}

export default App;
