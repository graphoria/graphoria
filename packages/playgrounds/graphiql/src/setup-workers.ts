import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker&inline";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker&inline";
import GraphQLWorker from "monaco-graphql/esm/graphql.worker.js?worker&inline";

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
