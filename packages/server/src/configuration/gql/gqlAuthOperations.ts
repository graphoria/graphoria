import type { BunRequest } from "bun";
import type { SelectionAnalysis } from "../../analyzeQuery/types";
import type { Auth } from "../../types/configuration";
import type { SessionContext } from "../../utils/sessionVariables";

import { resolveVariableRef } from "../../analyzeQuery/resolveVariables";
import { checkUserCredentials } from "../../databases";
import { getTokenService } from "../../singletons/authentication";

// Handle auth mutations: auth_login / auth_refresh / auth_logout
export const handleAuthMutation = async (
  field: SelectionAnalysis,
  variables: Record<string, unknown>,
  auth: Auth | null,
  req?: BunRequest,
  session?: SessionContext,
): Promise<{ data: object }> => {
  if (!auth?.enabled) {
    throw new Error("Authentication is not enabled");
  }

  if (field.name === "auth_login") {
    const { username, password } = field.arguments ?? {};

    const usernameValue = resolveVariableRef(variables, username);
    const passwordValue = resolveVariableRef(variables, password);

    if (!usernameValue || !passwordValue) {
      throw new Error("Username and password are required");
    }

    const result = await checkUserCredentials(
      auth,
      usernameValue.toString(),
      passwordValue.toString(),
    );

    if (!result.valid) {
      throw new Error("Invalid username or password");
    }

    const data = await getTokenService().createTokenPair({
      sub: usernameValue.toString(),
      role: result.role,
      claims: result.claims,
    });

    if (req?.cookies) {
      // Set the HTTP-only cookie
      // Implementation to set HTTP-only cookie goes here
      const cookies = req.cookies;

      cookies.set("refresh_token", data.refresh_token, {
        httpOnly: true, // Can't be accessed by JS
        secure: true, // Only sent over HTTPS (disable for localhost dev)
        sameSite: "strict", // Prevents CSRF
      });
    }

    return {
      data: {
        [field.alias || field.name]: {
          access_token: data.access_token,
          expires_in: data.expires_in,
          role: result.role,
        },
      },
    };
  }

  if (field.name === "auth_refresh") {
    if (req?.cookies) {
      // Set the HTTP-only cookie
      // Implementation to set HTTP-only cookie goes here
      const cookies = req.cookies;

      const tokenValue = cookies.get("refresh_token");

      if (!tokenValue) {
        throw new Error("Refresh token is required");
      }

      const result = await getTokenService().refreshAccessToken(tokenValue.toString());

      // Set the HTTP-only cookie
      // Implementation to set HTTP-only cookie goes here
      cookies.set("refresh_token", result.refresh_token, {
        httpOnly: true, // Can't be accessed by JS
        secure: true, // Only sent over HTTPS (disable for localhost dev)
        sameSite: "strict", // Prevents CSRF
      });

      return {
        data: {
          [field.alias || field.name]: {
            access_token: result.access_token,
            expires_in: result.expires_in,
            role: result.role,
          },
        },
      };
    }
  }

  if (field.name === "auth_logout") {
    const tokenService = getTokenService();

    if (session?.jti) {
      await tokenService.revoke(session.jti);
    }

    const refreshCookie = req?.cookies?.get("refresh_token");
    if (refreshCookie) {
      try {
        const refreshPayload = await tokenService.verifyToken(refreshCookie.toString(), {
          audience: "refresh",
        });
        await tokenService.revoke(refreshPayload.jti);
      } catch {
        // tampered or expired cookie — nothing to revoke
      }
    }

    if (req?.cookies) {
      req.cookies.delete("refresh_token");
    }

    return {
      data: {
        [field.alias || field.name]: true,
      },
    };
  }

  return { data: {} };
};

// Handle the auth_me query — returns { [alias]: { username, role } | null }
export const handleAuthMeQuery = (
  field: SelectionAnalysis,
  session?: SessionContext,
): Record<string, unknown> => {
  if (field.name === "auth_me") {
    const alias = field.alias || field.name;
    return {
      [alias]: session?.sub ? { username: session.sub, role: session.role } : null,
    };
  }
  return {};
};
