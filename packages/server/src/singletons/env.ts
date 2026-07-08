import { EnvZod } from "../types/env";

export const env = EnvZod.parse(process.env);
