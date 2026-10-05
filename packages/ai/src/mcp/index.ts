import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import type { BunRequest } from "bun";
import type {
  AiToolDeps,
  CreateMCPRoutesOptions,
  GetSchemaReturn,
  McpCaller,
} from "@graphoria/server";

import { createMcpServer } from "./create-server";

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );

const handleMcpPost =
  (deps: AiToolDeps, roles: Record<string, GetSchemaReturn>, options: CreateMCPRoutesOptions) =>
  async (req: Request, bunServer?: Bun.Server<unknown>) => {
    let caller: McpCaller;
    try {
      caller = await options.resolveCaller(req, bunServer);
    } catch {
      return jsonRpcError(400, -32600, "Bad request");
    }

    if (caller.limit && !caller.limit.allowed) return deps.rateLimited(caller.limit.retryAfterMs);

    // A matched secret carries a scope; a verified token carries a `jti`.
    if (options.requireAdminSecret && !caller.scope && !caller.session.jti) {
      return jsonRpcError(401, -32001, "Unauthorized: credential required");
    }

    const role = Object.hasOwn(roles, caller.role) ? roles[caller.role] : undefined;
    if (!role) return jsonRpcError(400, -32600, "Bad request");

    try {
      const server = createMcpServer(
        deps,
        role,
        { session: caller.session, req: req as BunRequest },
        options.openapiFor(caller.role),
        options,
      );

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      transport.onerror = (err: unknown) => {
        deps.logger("mcp").error({ err }, "transport error");
      };

      await server.connect(transport);

      return await transport.handleRequest(req);
    } catch (e) {
      deps.logger("mcp").error({ err: e }, "MCP handler failed");
      return jsonRpcError(500, -32603, "Internal server error");
    }
  };

const handleMcpGet = async (_req: Request) => jsonRpcError(405, -32000, "Method not allowed.");

const handleMcpDelete = async (_req: Request) => jsonRpcError(405, -32000, "Method not allowed.");

export const createMCPRoutes = (
  deps: AiToolDeps,
  roles: Record<string, GetSchemaReturn>,
  options: CreateMCPRoutesOptions,
) => ({
  POST: handleMcpPost(deps, roles, options),
  GET: handleMcpGet,
  DELETE: handleMcpDelete,
});
