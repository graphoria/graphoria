import { z } from "zod";

/**
 * Remote REST API configuration (OpenAPI-based)
 */
export const RemoteRESTConfigZod = z.object({
  /** Unique identifier for this remote REST API */
  name: z.string().min(1),
  /** Base URL of the remote API for proxying requests */
  url: z.url().optional(),
  /** URL to fetch the OpenAPI spec from */
  specUrl: z.url().optional(),
  /** Local file path to the OpenAPI spec (JSON or YAML) */
  specPath: z.string().optional(),
  /** Whether the remote REST API is enabled (default: true) */
  enabled: z.boolean().optional().default(true),
  /** Subpath prefix under /rest (default: name) */
  prefix: z.string().optional(),
  /** Static headers to send with every proxied request */
  headers: z.record(z.string(), z.string()).optional(),
  /** Client headers to forward to the remote endpoint */
  forwardHeaders: z.array(z.string()).optional(),
  /** Request timeout in milliseconds (default: 10000) */
  timeout: z.number().int().positive().optional().default(10000),
});

/** Authoring type for remote REST API config */
export type RemoteRESTConfig = z.input<typeof RemoteRESTConfigZod>;
