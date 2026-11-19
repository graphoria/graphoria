import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import type { AnyTRPCProcedure, AnyTRPCRouter } from "@trpc/server";
import type { BunRequest } from "bun";
import type { HandleGraphQLRequest } from "../configuration/gql/handleGraphQLRequestFactory";
import type { HandleRESTRequest } from "../configuration/rest/handleRESTRequestFactory";
import type { ConsumeResult } from "../utils/rateLimit";
import type { SessionContext } from "../utils/sessionVariables";

import { logger } from "../logging";
import { S200, setCorsHeaders } from "../utils/responses";

/** The caller of a request: what every procedure of that request runs as. */
export type TRPCContext = { role: string; session: SessionContext; req: BunRequest };

type RoleHandlers = {
  gql: Pick<HandleGraphQLRequest, "operatorQuery">;
  rest: Pick<HandleRESTRequest, "operationsEnhanced" | "operationRuntime">;
};

export type CreateTRPCHandlerOptions = {
  /** The mounted path, prefix included: tRPC strips it to read the procedure name. */
  endpoint: string;
  roles: Record<string, { handlers: RoleHandlers }>;
  maxBatchSize: number;
  enableCors: boolean;
  /** The same resolution as REST: token or admin secret, one rate-limit check, the audit record. */
  resolveCaller: (
    req: Request,
    server?: Bun.Server<unknown>,
  ) => Promise<{ role: string; session: SessionContext; limit?: ConsumeResult }>;
};

const log = logger("trpc");

// isDev false: a stack is never sent.
const t = initTRPC.context<TRPCContext>().create({ isDev: false });

// `name` too, as tRPC itself checks: a second copy of the package still throws a TRPCError.
const isTRPCError = (error: unknown): error is TRPCError =>
  error instanceof TRPCError || (error instanceof Error && error.name === "TRPCError");

// tRPC sends an unknown error's own message to the client, so one is never handed over as is.
const internalError = () =>
  new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Internal server error" });

/**
 * One role's router: a procedure per operation the role is granted. An
 * ungranted operation is absent, so tRPC answers it as a name that does not
 * exist, before it checks the method or parses the input.
 */
const buildRouter = (role: string, { gql, rest }: RoleHandlers, argumentless: Set<string>) => {
  const { initDataOf, handlerOptions, cacheFor } = rest.operationRuntime;
  // Concurrent misses on one key share one execution, as on REST.
  const inflight = new Map<string, Promise<unknown>>();
  const procedures: Record<string, AnyTRPCProcedure> = {};

  for (const [name, route] of Object.entries(rest.operationsEnhanced)) {
    // The auth routes stay on REST and GraphQL.
    if (route.authOperation) continue;

    const type = route.rest?.method === "GET" ? "query" : "mutation";

    if (!route.input && (route.rest?.pathParams || route.rest?.queryParams || route.rest?.body)) {
      argumentless.add(name);
    }

    const execute = async (variables: Record<string, unknown>, ctx: TRPCContext) => {
      if (route.handler) {
        const output = await route.handler(handlerOptions(), variables);

        return route.hooks?.afterRequest ? route.hooks.afterRequest({ output }) : output;
      }

      // The payload itself, not REST's `{ data }` envelope: tRPC wraps it in its own.
      const { data } = await gql.operatorQuery(
        route.queryStructure!,
        variables,
        ctx.req,
        ctx.session,
        route.timeout,
      );

      return route.hooks?.afterRequest ? route.hooks.afterRequest({ output: data }) : data;
    };

    // The operation's REST store under tRPC's own keys: the stored shape differs,
    // so the two surfaces never read each other's entries. The key carries
    // `variables`, which is what InvalidationHelper matches on.
    const cached = async (variables: Record<string, unknown>, ctx: TRPCContext) => {
      const cache = route.query ? cacheFor(route.routeKey) : undefined;
      if (!cache) return execute(variables, ctx);

      const key = JSON.stringify({
        trpc: route.routeKey,
        variables,
        sub: ctx.session.sub,
        role: ctx.session.role,
      });

      // Stored after afterRequest, so a hit does not run the hook again.
      const hit = await cache.get(key);
      if (hit !== undefined) return JSON.parse(hit);

      const pending = inflight.get(key);
      if (pending) return pending;

      const miss = (async () => {
        const payload = await execute(variables, ctx);
        // `undefined` (an afterRequest that returns nothing) has no JSON text: answered, not stored.
        const serialized = JSON.stringify(payload);
        if (serialized !== undefined) await cache.set(key, serialized);

        return payload;
      })();
      inflight.set(key, miss);
      try {
        return await miss;
      } finally {
        inflight.delete(key);
      }
    };

    const resolve = async ({ input, ctx }: { input: unknown; ctx: TRPCContext }) => {
      log.debug({ operation: name, type, role }, "trpc call");

      if (route.hasError) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "You are not authorized" });
      }

      try {
        const initData = await initDataOf(route);

        // A hook that serves both surfaces reads `input`: the REST sources are never set here.
        const variables: Record<string, unknown> =
          (await route.hooks?.beforeRequest?.(
            { input: input ?? {}, pathParams: undefined, queryParams: undefined, body: undefined },
            initData,
          )) ??
          input ??
          {};

        return await cached(variables, ctx);
      } catch (error) {
        if (isTRPCError(error)) throw error;

        log.error({ err: error, operation: name, role }, "trpc operation failed");
        throw internalError();
      }
    };

    // Without `input` the procedure takes none: what the client sends is ignored.
    const procedure = route.input ? t.procedure.input(route.input) : t.procedure;
    procedures[name] = type === "query" ? procedure.query(resolve) : procedure.mutation(resolve);
  }

  return t.router(procedures);
};

/**
 * The `/trpc/*` route: every role's router, built once, and the handler that
 * sends a request to its caller's.
 */
export const createTRPCHandler = ({
  endpoint,
  roles,
  maxBatchSize,
  enableCors,
  resolveCaller,
}: CreateTRPCHandlerOptions) => {
  const argumentless = new Set<string>();
  const routers = new Map<string, AnyTRPCRouter>();
  for (const [role, { handlers }] of Object.entries(roles)) {
    routers.set(role, buildRouter(role, handlers, argumentless));
  }
  const emptyRouter = t.router({});

  if (argumentless.size > 0) {
    log.warn(
      { operations: [...argumentless] },
      "operations declare REST parameters but no input: tRPC serves them without arguments",
    );
  }

  return async (req: BunRequest, server?: Bun.Server<unknown>): Promise<Response> => {
    if (req.method === "OPTIONS" && enableCors) return new S200(null);

    // Resolved outside tRPC: the caller's role picks the router. A failure is
    // not answered here, where it would be a body the tRPC client cannot parse:
    // createContext throws it, and every call of the request answers it in
    // tRPC's envelope.
    let caller: TRPCContext | undefined;
    let failure: TRPCError | undefined;
    let retryAfter: string | undefined;

    try {
      const { role, session, limit } = await resolveCaller(req, server);
      caller = { role, session, req };

      if (limit && !limit.allowed) {
        failure = new TRPCError({ code: "TOO_MANY_REQUESTS" });
        // As S429 computes it: seconds, and never 0.
        retryAfter = String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000)));
      }
    } catch (error) {
      log.error({ err: error }, "trpc caller resolution failed");
      failure = internalError();
    }

    return fetchRequestHandler({
      endpoint,
      req,
      // No role is known for a caller that failed to resolve: every name is NOT_FOUND.
      router: (caller && routers.get(caller.role)) ?? emptyRouter,
      allowBatching: true,
      maxBatchSize,
      createContext: () => {
        if (failure || !caller) throw failure ?? internalError();

        return caller;
      },
      // On every answer, whatever its calls answer: tRPC checks the name and the
      // method before it reads the context, and a stream's head is written
      // before any error is known.
      responseMeta: () => {
        const headers = new Headers();
        setCorsHeaders(headers);
        if (retryAfter) headers.set("Retry-After", retryAfter);

        return { headers };
      },
    });
  };
};
