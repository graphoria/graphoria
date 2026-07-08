import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";
import GraphQLWorker from "monaco-graphql/esm/graphql.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "graphql":
        return new GraphQLWorker();
      default:
        return new EditorWorker();
    }
  },
};
