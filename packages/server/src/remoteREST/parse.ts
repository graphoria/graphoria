import type { RemoteRESTConfig } from "../config";
import type { OpenAPIV3_1 } from "openapi-types";

/**
 * Parse an OpenAPI spec from a remote URL or local file path.
 * Supports both JSON and YAML formats.
 */
export const parseRemoteOpenAPI = async (
  config: RemoteRESTConfig,
): Promise<OpenAPIV3_1.Document> => {
  let rawText: string;

  if (config.specUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout ?? 10000);

    try {
      const response = await fetch(config.specUrl, {
        headers: config.headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Remote REST "${config.name}" spec fetch failed: HTTP ${response.status}`);
      }

      rawText = await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  } else if (config.specPath) {
    const file = Bun.file(config.specPath);
    const exists = await file.exists();

    if (!exists) {
      throw new Error(`Remote REST "${config.name}" spec file not found: ${config.specPath}`);
    }

    rawText = await file.text();
  } else {
    throw new Error(`Remote REST "${config.name}" requires either specUrl or specPath`);
  }

  return parseSpecText(rawText, config.name);
};

/**
 * Parse raw text as JSON or YAML OpenAPI spec
 */
const parseSpecText = (text: string, name: string): OpenAPIV3_1.Document => {
  const trimmed = text.trimStart();

  // Try JSON first (starts with { or [)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(text) as OpenAPIV3_1.Document;
    } catch {
      throw new Error(`Remote REST "${name}" spec is not valid JSON`);
    }
  }

  // Otherwise, parse as YAML using Bun's built-in YAML parser
  try {
    return Bun.YAML.parse(text) as OpenAPIV3_1.Document;
  } catch {
    throw new Error(`Remote REST "${name}" spec is not valid YAML`);
  }
};
