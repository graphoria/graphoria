import type { OpenAPIV3_1 } from "openapi-types";
import type { SelectionAnalysis } from "../../analyzeQuery/types";
import type { GetSchemaReturn } from "../../configuration/getSchemas";
import type { RemoteRESTResolved } from "../../remoteREST/types";
import type { Env } from "../../types/env";

import { convertFromZod, errors } from "./openApiErrors";

const processSelections = (
  schema: GetSchemaReturn,
  name: string,
  selections: SelectionAnalysis[] = [],
) =>
  selections.reduce<Record<string, unknown>>((acc, field) => {
    const type = schema.getColumnTypeForOpenApi(name, field.name);

    if (field.isArray) {
      acc[field.alias || field.name] = {
        type: "array",
        items: {
          type: "object",
          properties: processSelections(schema, field.name, field.selections),
          required: (field.selections ?? [])
            .filter((f) => f.isRequired)
            .map((f) => f.alias || f.name),
        },
      };
    } else {
      acc[field.alias || field.name] = field.selections
        ? {
            type: "object",
            properties: processSelections(schema, field.name, field.selections),
            required: field.selections.filter((f) => f.isRequired).map((f) => f.alias || f.name),
          }
        : { type };
    }

    return acc;
  }, {});

type GenerateOpenAPIParams = {
  title?: string;
  version?: string;
  schema: GetSchemaReturn;
  options: Env;
  remoteRESTApis?: RemoteRESTResolved[];
  /** When set, adds the admin-only AI agent endpoint to the spec. */
  ai?: { path: string };
};

export const getTags = (url: string) => {
  if (url.startsWith("/auth")) return ["Auth"];

  return ["Data"];
};

export const generateOpenAPI = ({
  title = "REST API",
  version = "1.0.0",
  schema,
  options,
  remoteRESTApis = [],
  ai,
}: GenerateOpenAPIParams): OpenAPIV3_1.Document => {
  // Build remote REST paths and schemas
  const remotePaths: Record<string, OpenAPIV3_1.PathItemObject> = {};
  const remoteSchemas: Record<string, OpenAPIV3_1.SchemaObject> = {};
  const remoteTags: OpenAPIV3_1.TagObject[] = [];

  for (const rr of remoteRESTApis) {
    Object.assign(remotePaths, rr.openApiPaths);
    Object.assign(remoteSchemas, rr.openApiSchemas);
    remoteTags.push({
      name: rr.prefix,
      description: `Remote REST API: ${rr.config.name}`,
    });
  }

  return {
    openapi: "3.1.0",
    info: {
      title,
      version,
    },
    servers: [
      {
        url: `${options.prefix}${options.restApiPrefix}`,
        description: "Development server",
      },
    ],
    tags: [
      {
        name: "Auth",
        description: "Authentication endpoints",
      },
      {
        name: "Data",
        description: "Data endpoints",
      },
      ...(ai
        ? [
            {
              name: "AI",
              description: "AI agent — natural-language → database Q&A (admin-secret only)",
            },
          ]
        : []),
      ...remoteTags,
    ],
    components: {
      schemas: { ...errors, ...remoteSchemas },
      securitySchemes: {
        "HTTP Bearer Token": {
          description: "HTTP authentication with bearer token",
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
        "Admin Secret": {
          description: "API key authentication via custom header",
          type: "apiKey",
          in: "header",
          name: "x-admin-secret",
        },
      },
    },
    paths: {
      ...Object.entries(schema.handlers.rest.operationsEnhanced).reduce<
        Record<string, Record<string, unknown>>
      >((acc, [key, value]) => {
        // Skip if neither queryStructure nor responseSchema is available
        if (!value.queryStructure && !value.output) {
          return acc;
        }

        // Build response schema: from responseSchema (custom handler) or queryStructure (query-based)
        const responseDataSchema = value.output
          ? convertFromZod(value.output)
          : (() => {
              const fields = value.queryStructure!.operations[0].fields;
              return {
                type: "object" as const,
                properties: fields.reduce<Record<string, unknown>>((acc, field) => {
                  if (field.isArray) {
                    acc[field.alias || field.name] = {
                      type: "array",
                      items: {
                        type: "object",
                        properties: processSelections(schema, field.name, field.selections!),
                        required: (field.selections ?? [])
                          .filter((f) => f.isRequired)
                          .map((f) => f.alias || f.name),
                      },
                    };
                  } else {
                    acc[field.alias || field.name] = {
                      type: "object",
                      properties: processSelections(schema, field.name, field.selections!),
                      required: (field.selections ?? [])
                        .filter((f) => f.isRequired)
                        .map((f) => f.alias || f.name),
                    };
                  }
                  return acc;
                }, {}),
                required: fields.filter((f) => f.isRequired).map((f) => f.alias || f.name),
              };
            })();

        const hasParameters = value.input;

        const pathParametersPOJO = convertFromZod(value.rest!.pathParams!);
        const queryParametersPOJO = convertFromZod(value.rest!.queryParams!);
        const bodyParametersPOJO = convertFromZod(value.rest!.body!);

        const hasBody = Object.keys(bodyParametersPOJO.properties ?? {}).length > 0;

        const finalPath = value.rest!.path.replace(/:(\w+)/g, "{$1}");

        return {
          ...acc,
          [finalPath]: {
            ...acc[finalPath],
            [value.rest!.method!.toLowerCase()]: {
              tags: getTags(value.rest!.path),
              summary: key,
              description: value.description,
              operationId: key,
              parameters: [
                ...(Object.entries(
                  pathParametersPOJO.properties ?? ({} as OpenAPIV3_1.SchemaObject),
                ).map(([key, { type }]) => ({
                  name: key,
                  in: "path",
                  required: true,
                  schema: {
                    type,
                  },
                })) ?? []),
                ...Object.entries(
                  queryParametersPOJO.properties ?? ({} as OpenAPIV3_1.SchemaObject),
                ).map(([key, { type, required }]) => ({
                  name: key,
                  in: "query",
                  required,
                  schema: {
                    type,
                  },
                })),
              ],
              ...(hasBody && ["POST", "PUT", "PATCH"].includes(value.rest!.method!)
                ? {
                    requestBody: {
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: Object.entries(
                              bodyParametersPOJO.properties ?? ({} as OpenAPIV3_1.SchemaObject),
                            ).reduce<
                              Record<
                                string,
                                {
                                  type: string;
                                }
                              >
                            >((acc, [key, value]) => {
                              acc[key] = value;

                              return acc;
                            }, {}),
                            required: bodyParametersPOJO.required,
                          },
                        },
                      },
                    },
                  }
                : {}),
              responses: {
                200: {
                  description: "Successful response",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          data: responseDataSchema,
                        },
                      },
                    },
                  },
                },
                ...(hasParameters
                  ? {
                      "400": {
                        description: "Validation error",
                        content: {
                          "application/json": {
                            schema: {
                              $ref: "#/components/schemas/ValidationError",
                            },
                          },
                        },
                      },
                    }
                  : {}),
                "401": {
                  description: "Unauthorized",
                  content: {
                    "application/json": {
                      schema: {
                        $ref: "#/components/schemas/UnauthorizedError",
                      },
                    },
                  },
                },
                "403": {
                  description: "Forbidden",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/ForbiddenError" },
                    },
                  },
                },
                "404": {
                  description: "Not found",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/NotFoundError" },
                    },
                  },
                },
              },
            },
          },
        };
      }, {}),
      ...(ai
        ? {
            [ai.path]: {
              post: {
                tags: ["AI"],
                summary: "Ask the AI agent",
                description:
                  "Send a natural-language question about the database. The agent discovers relevant tables, runs read-only GraphQL queries, and returns an answer. Requires admin secret.",
                operationId: "askAI",
                security: [{ "Admin Secret": [] }],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          prompt: {
                            type: "string",
                            description: "Natural-language question about the database",
                          },
                        },
                        required: ["prompt"],
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "Agent answer",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { answer: { type: "string" } },
                        },
                      },
                    },
                  },
                  "400": {
                    description: "Bad request",
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/ValidationError" },
                      },
                    },
                  },
                  "404": {
                    description: "Not found (missing admin secret)",
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/NotFoundError" },
                      },
                    },
                  },
                },
              },
            },
          }
        : {}),
      ...remotePaths,
    },
  };
};
