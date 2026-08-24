interface Window {
  __GRAPHQL_URL__: string;
}

declare module "*?worker&inline" {
  const InlineWorker: new (options?: WorkerOptions) => Worker;
  export default InlineWorker;
}
