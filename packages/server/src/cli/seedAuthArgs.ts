import { parseArgs } from "util";

export type SeedAuthArgs = {
  user: string;
  password: string;
  role: string;
  config: string;
  claims?: Record<string, unknown>;
};

const parseClaims = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("--claims must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --claims JSON: ${msg}`);
  }
};

export const parseSeedAuthArgs = (argv: string[]): SeedAuthArgs => {
  const { values } = parseArgs({
    args: argv,
    options: {
      user: { type: "string", short: "u" },
      password: { type: "string", short: "p" },
      role: { type: "string", short: "r" },
      config: { type: "string", short: "c" },
      claims: { type: "string" },
    },
    strict: true,
  });

  if (!values.user) throw new Error("--user is required");
  if (!values.password) throw new Error("--password is required");
  if (!values.role) throw new Error("--role is required");
  if (!values.config) throw new Error("--config is required");

  return {
    user: values.user,
    password: values.password,
    role: values.role,
    config: values.config,
    claims: parseClaims(values.claims),
  };
};
