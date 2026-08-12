import { omit } from "es-toolkit";
import { z } from "zod";

import type { OpenAPIV3_1 } from "openapi-types";

export const convertFromZod = (type?: z.ZodType): OpenAPIV3_1.NonArraySchemaObject => {
  if (!type)
    return {
      type: "object",
    };

  return omit(z.toJSONSchema(type, { io: "input" }), ["$schema"]);
};

// Base error
export const BaseError = z
  .object({
    code: z.string().describe("Machine-readable error code"),
    message: z.string().describe("Human-readable error message"),
    status: z.number().describe("HTTP status code"),
    traceId: z.string().optional().describe("Correlation ID for debugging"),
  })
  .meta({
    example: {
      code: "ERROR_CODE",
      message: "Error message",
      status: 400,
      traceId: "fee0f7ce-5f80-4649-af6f-0a4d2926f84e",
    },
  })
  .describe("Base error object");

// Validation error
export const ValidationError = BaseError.extend({
  fields: z
    .array(
      z.object({
        field: z.string().describe("Name of the invalid field"),
        issue: z.string().describe("Explanation of the validation issue"),
      }),
    )
    .describe("Validation errors for specific fields"),
})
  .meta({
    example: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      status: 400,
      traceId: "fee0f7ce-5f80-4649-af6f-0a4d2926f84e",
      fields: [
        {
          field: "email",
          issue: "Invalid email format",
        },
        {
          field: "password",
          issue: "Password must be at least 8 characters",
        },
      ],
    },
  })
  .describe("Validation error object");

// Unauthorized error
export const UnauthorizedError = BaseError.meta({
  example: {
    code: "UNAUTHORIZED",
    message: "Authentication required",
    status: 401,
    traceId: "fee0f7ce-5f80-4649-af6f-0a4d2926f84e",
  },
}).describe("Unauthorized error");

// Forbidden error
export const ForbiddenError = BaseError.meta({
  example: {
    code: "FORBIDDEN",
    message: "Insufficient permissions",
    status: 403,
    traceId: "fee0f7ce-5f80-4649-af6f-0a4d2926f84e",
  },
}).describe("Forbidden error");

// Not found error
export const NotFoundError = BaseError.meta({
  example: {
    code: "NOT_FOUND",
    message: "Resource not found",
    status: 404,
    traceId: "fee0f7ce-5f80-4649-af6f-0a4d2926f84e",
  },
}).describe("Not found error");

// Union of all errors
export const ErrorResponse = z
  .union([ValidationError, UnauthorizedError, ForbiddenError, NotFoundError])
  .describe("General error response (can be any of the defined error types)");

export const errors = {
  BaseError: convertFromZod(BaseError),
  ValidationError: convertFromZod(ValidationError),
  UnauthorizedError: convertFromZod(UnauthorizedError),
  ForbiddenError: convertFromZod(ForbiddenError),
  NotFoundError: convertFromZod(NotFoundError),
  ErrorResponse: convertFromZod(ErrorResponse),
};
