// The package's `exports` field doesn't expose dist/browser/, so we import via
// a relative node_modules path. Vite resolves filesystem paths without going
// through package exports.
import scalarStandaloneUrl from "../../node_modules/@scalar/api-reference/dist/browser/standalone.js?url";
import { getToken } from "./auth";

const openapiUrl = window.__OPENAPI_URL__;
const isConfigured = openapiUrl && !openapiUrl.startsWith("{{");

if (!isConfigured) {
  const container = document.getElementById("scalar-client");
  if (container) {
    container.innerHTML =
      '<div class="missing-endpoint">' +
      "<h1>Scalar - Missing endpoint</h1>" +
      "<p>No OpenAPI URL configured. Replace <code>{{OPENAPI_URL}}</code> " +
      "in the served HTML before serving.</p>" +
      "</div>";
  }
} else {
  const script = document.createElement("script");
  script.src = scalarStandaloneUrl;
  script.onload = () => {
    window.Scalar.createApiReference("#scalar-client", {
      url: openapiUrl,
      hideClientButton: true,
      withDefaultFonts: false,
      hideDarkModeToggle: true,
      defaultOpenAllTags: true,
      hideModels: true,
      showDeveloperTools: "never",
      agent: { disabled: true },
      authentication: {
        preferredSecurityScheme: "bearerAuth",
        http: { bearer: { token: getToken() } },
      },
      onBeforeRequest: (request: { request: { headers: Headers } }) => {
        const token = getToken();
        if (token && !request.request.headers.has("Authorization")) {
          request.request.headers.append("Authorization", `Bearer ${token}`);
        }
        return request;
      },
    });
  };
  document.body.appendChild(script);
}
