import { createBunServer } from "@graphoria/server";

// No `port` here: the server listens on PORT (default 3000), the port the
// image's healthcheck probes.
const { server, prefixes } = await createBunServer({
  configuration: "./graphoria.ts",
});

console.log(`GraphQL  → http://localhost:${server.port}${prefixes.graphql}`);
console.log(`REST     → http://localhost:${server.port}${prefixes.rest}`);
console.log(`GraphiQL → http://localhost:${server.port}${prefixes.graphiql}`);
console.log(`Scalar   → http://localhost:${server.port}${prefixes.scalar}`);
