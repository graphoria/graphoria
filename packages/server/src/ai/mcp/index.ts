import { timingSafeEqual } from "crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import type { AnalyzedConfiguration } from "../../configuration";
import type { CreateMcpServerOptions } from "./create-server";

import { createMcpServer } from "./create-server";
import { logger } from "../../logging";

const safeCompare = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

export type CreateMCPRoutesOptions = CreateMcpServerOptions & {
  requireAdminSecret?: boolean;
  adminSecret?: string;
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

const handleMcpPost =
  (analyzedConfiguration: AnalyzedConfiguration, options: CreateMCPRoutesOptions) =>
  async (req: Request) => {
    if (options.requireAdminSecret) {
      const headerName = options.adminSecretHeader ?? "x-admin-secret";
      const provided = req.headers.get(headerName);
      const expected = options.adminSecret ?? "";
      if (!provided || !expected || !safeCompare(provided, expected)) {
        return jsonRpcError(401, -32001, "Unauthorized: admin secret required");
      }
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
