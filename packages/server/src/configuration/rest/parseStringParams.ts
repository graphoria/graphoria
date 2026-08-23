import type { z } from "zod";

/**
 * The slice of Zod's runtime schema internals this module walks to find which
 * keys of a `z.object()` ultimately validate a boolean.
 */
type SchemaDef = {
  type: string;
  innerType?: { def: SchemaDef };
  in?: { def: SchemaDef };
  shape?: Record<string, { def: SchemaDef }>;
};

/** Wrappers that keep the validated type of the schema they wrap. */
const wrappers = new Set([
  "optional",
  "nullable",
  "nonoptional",
  "default",
  "prefault",
  "catch",
  "readonly",
]);

/** Accepted spellings, matching the ones `z.stringbool()` recognizes. */
const truthy = new Set(["true", "1", "yes", "on", "y", "enabled"]);
const falsy = new Set(["false", "0", "no", "off", "n", "disabled"]);

const defOf = (schema: z.ZodType) => (schema as unknown as { def: SchemaDef }).def;

const resolveType = (def: SchemaDef): string => {
  if (wrappers.has(def.type) && def.innerType) return resolveType(def.innerType.def);
  // A pipe validates its input side, so `z.stringbool()` resolves to a string.
  if (def.type === "pipe" && def.in) return resolveType(def.in.def);

  return def.type;
};

// Schemas are created once at config time, so the key scan is done once per schema.
const booleanKeysCache = new WeakMap<z.ZodType, Set<string>>();

const booleanKeys = (schema: z.ZodType) => {
  const cached = booleanKeysCache.get(schema);
  if (cached) return cached;

  const keys = new Set<string>();
  for (const [key, field] of Object.entries(defOf(schema).shape ?? {})) {
    if (resolveType(field.def) === "boolean") keys.add(key);
  }

  booleanKeysCache.set(schema, keys);

  return keys;
};

/**
 * Parses path or query parameters, which always arrive as strings.
 *
 * A parameter declared as `z.boolean()` — the declaration that makes the
 * OpenAPI docs render a true/false picker instead of a free-text box — would
 * never parse on its own, so those keys (and only those) are converted before
 * validation. A value that spells neither true nor false is left as the string
 * it was, so Zod still reports it as invalid.
 *
 * Returns `undefined` when no schema is configured for that source, which is
 * what the REST handler forwards to `beforeRequest`.
 */
export const parseStringParams = (
  schema: z.ZodType | undefined,
  values: Record<string, string | string[]>,
): Record<string, unknown> | undefined => {
  if (!schema) return undefined;

  const keys = booleanKeys(schema);

  if (keys.size === 0) return schema.parse(values) as Record<string, unknown>;

  const coerced: Record<string, unknown> = { ...values };

  for (const key of keys) {
    const value = coerced[key];

    if (typeof value !== "string") continue;

    const spelling = value.toLowerCase();

    if (truthy.has(spelling)) coerced[key] = true;
    else if (falsy.has(spelling)) coerced[key] = false;
  }

  return schema.parse(coerced) as Record<string, unknown>;
};
