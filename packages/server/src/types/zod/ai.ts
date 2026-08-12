import { z } from "zod";

import { AIZod, MCPZod } from "../../config/types/ai";

export { AIZod, MCPZod };

/** Runtime (z.output) type for AI configuration — used by singletons/ai.ts */
export type AIConfig = z.output<typeof AIZod>;
