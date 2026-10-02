import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import type { BunRequest } from "bun";
import type { OpenAPIV3_1 } from "openapi-types";
import type { Capability } from "../../authentication/capabilities";
import type { AnalyzedConfiguration } from "../../configuration";
import type { ConsumeResult } from "../../utils/rateLimit";
import type { SessionContext } from "../../utils/sessionVariables";
import type { CreateMcpServerOptions } from "./create-server";

import { createMcpServer } from "./create-server";
import { logger } from "../../logging";
import { S429 } from "../../utils/responses";

/**
 * A caller as `/graphql` resolves one: its role, its session, the credential it
 * presented (`scope`), and its rate-limit verdict.
 */
export type McpCaller = {
  role: string;
  session: SessionContext;
  scope?: Capability | "all";
  limit?: ConsumeResult;
};

export type CreateMCPRoutesOptions = CreateMcpServerOptions & {
  /** Refuse a caller that presented no credential: the admin secret, `AI_MCP_SECRET`, or a valid bearer token. */
  requireAdminSecret?: boolean;
  resolveCaller: (req: Request, server?: Bun.Server<unknown>) => Promise<McpCaller>;
  /** The OpenAPI document `openapi://spec` shows a role. */
  openapiFor: (role: string) => OpenAPIV3_1.Document;
};

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
  (analyzedConfiguration: AnalyzedConfiguration, options: CreateMCPRoutesOptions) =>
  async (req: Request, bunServer?: Bun.Server<unknown>) => {
    let caller: McpCaller;
    try {
      caller = await options.resolveCaller(req, bunServer);
    } catch {
      return jsonRpcError(400, -32600, "Bad request");
    }

    if (caller.limit && !caller.limit.allowed) return new S429(caller.limit.retryAfterMs);

    // A matched secret carries a scope; a verified token carries a `jti`.
    if (options.requireAdminSecret && !caller.scope && !caller.session.jti) {
      return jsonRpcError(401, -32001, "Unauthorized: credential required");
    }

    const { roles } = analyzedConfiguration;
    const role = Object.hasOwn(roles, caller.role) ? roles[caller.role] : undefined;
    if (!role) return jsonRpcError(400, -32600, "Bad request");

    try {
      const server = createMcpServer(
        role,
        { session: caller.session, req: req as BunRequest },
        options.openapiFor(caller.role),
        options,
      );

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      transport.onerror = (err: unknown) => {
        logger("mcp").error({ err }, "transport error");
      };

      await server.connect(transport);

      return await transport.handleRequest(req);
    } catch (e) {
      logger("mcp").error({ err: e }, "MCP handler failed");
      return jsonRpcError(500, -32603, "Internal server error");
    }
  };

const handleMcpGet = async (_req: Request) => jsonRpcError(405, -32000, "Method not allowed.");

const handleMcpDelete = async (_req: Request) => jsonRpcError(405, -32000, "Method not allowed.");

export const createMCPRoutes = (
  analyzedConfiguration: AnalyzedConfiguration,
  options: CreateMCPRoutesOptions,
) => ({
  POST: handleMcpPost(analyzedConfiguration, options),
  GET: handleMcpGet,
  DELETE: handleMcpDelete,
});
