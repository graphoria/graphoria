import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import type { AnalyzedConfiguration } from "../../configuration";
import type { CreateMcpServerOptions } from "./create-server";

import { createMcpServer } from "./create-server";
import { matchesAnySecret } from "../../authentication/secrets";
import { logger } from "../../logging";
import { audit } from "../../logging/audit";

export type CreateMCPRoutesOptions = CreateMcpServerOptions & {
  requireAdminSecret?: boolean;
  adminSecrets?: string[];
  adminSecretHeader?: string;
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

type RequestServer = { requestIP(req: Request): { address: string } | null };

const handleMcpPost =
  (analyzedConfiguration: AnalyzedConfiguration, options: CreateMCPRoutesOptions) =>
  async (req: Request, bunServer?: RequestServer) => {
    if (options.requireAdminSecret) {
      const headerName = options.adminSecretHeader ?? "x-admin-secret";
      if (!matchesAnySecret(req.headers.get(headerName), options.adminSecrets ?? [])) {
        return jsonRpcError(401, -32001, "Unauthorized: admin secret required");
      }
      const ip = bunServer?.requestIP(req)?.address;
      audit().emit({
        action: "admin_secret.used",
        actor: { type: "admin_secret", ...(ip ? { ip } : {}) },
        target: { kind: "mcp" },
      });
    }

    const server = createMcpServer(analyzedConfiguration, options);

    try {
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
  options: CreateMCPRoutesOptions = {},
) => ({
  POST: handleMcpPost(analyzedConfiguration, options),
  GET: handleMcpGet,
  DELETE: handleMcpDelete,
});
