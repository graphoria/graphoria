import { createHandlers } from "@graphoria/server";
import { serve } from "bun";
import fe from "./fe/index.html";

const { serverHandlers, prefixes, logger } = await createHandlers();

const server = serve({
  ...serverHandlers,
  routes: {
    ...serverHandlers.routes,
    "/*": fe,
  },
  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

const log = logger("taskly");

log.info(`GraphQL  → http://localhost:${server.port}${prefixes.graphql}`);
log.info(`REST     → http://localhost:${server.port}${prefixes.rest}`);
log.info(`GraphiQL → http://localhost:${server.port}${prefixes.graphiql}`);
log.info(`Scalar   → http://localhost:${server.port}${prefixes.scalar}`);
log.info(`Console  → http://localhost:${server.port}${prefixes.console}`);
log.info(`Frontend → http://localhost:${server.port}`);
