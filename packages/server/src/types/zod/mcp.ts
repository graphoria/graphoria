import { z } from "zod";

import { MCPZod } from "../../config/types/ai";

export { MCPZod };

/** Runtime (z.output) type for MCP configuration */
export type MCPConfig = z.output<typeof MCPZod>;
