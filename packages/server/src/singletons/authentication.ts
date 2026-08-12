import type { TokenService } from "../authentication/types";

import { createJWTService } from "../authentication/jwt";
import { env } from "./env";

// Default to JWT; overridden after configuration is parsed via setTokenService()
let tokenService: TokenService = createJWTService(env);

export const getTokenService = (): TokenService => tokenService;

export const setTokenService = (service: TokenService): void => {
  tokenService = service;
};
