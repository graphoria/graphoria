import { z } from "zod";

/**
 * Remote GraphQL schema introspection configuration
 */
export const RemoteSchemaIntrospectionConfigZod = z
  .object({
    /** Re-introspect interval in ms (0 = only at startup, default: 0) */
    interval: z.number().int().min(0).optional().default(0),
  })
  .optional();

/** Authoring type for remote schema introspection config */
export type RemoteSchemaIntrospectionConfig = z.input<typeof RemoteSchemaIntrospectionConfigZod>;

/**
 * Remote GraphQL schema configuration
 */
export const RemoteSchemaConfigZod = z.object({
  /** Unique identifier for this remote schema */
  name: z.string().min(1),
  /** Remote GraphQL endpoint URL */
  url: z.url(),
  /** Whether the remote schema is enabled (default: true) */
  enabled: z.boolean().optional().default(true),
  /** Type/field prefix (default: name + "_") */
  prefix: z.string().optional(),
  /** Static headers to send with every request */
  headers: z.record(z.string(), z.string()).optional(),
  /** Client headers to forward to the remote endpoint */
  forwardHeaders: z.array(z.string()).optional(),
  /** Request timeout in milliseconds (default: 10000) */
  timeout: z.number().int().positive().optional().default(10000),
  /** Introspection configuration */
  introspection: RemoteSchemaIntrospectionConfigZod,
});

/** Authoring type for remote GraphQL schema config */
export type RemoteSchemaConfig = z.input<typeof RemoteSchemaConfigZod>;
