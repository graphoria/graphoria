import type { TokenService } from "../authentication/types";

import { createJWTService } from "../authentication/jwt";
import { env } from "./env";

// JWT until setTokenService installs the configured service. Built on first use:
// the JWT service asks for its loggers when it is built, and a logger asked for
// while the package loads fixes the default root before configureLogging runs.
let tokenService: TokenService | undefined;

export const getTokenService = (): TokenService => (tokenService ??= createJWTService(env));

export const setTokenService = (service: TokenService): void => {
  tokenService = service;
};
