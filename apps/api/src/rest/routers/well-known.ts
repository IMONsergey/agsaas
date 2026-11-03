import { SCOPES } from "@api/utils/scopes";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getApiUrl, getAppUrl } from "@midday/utils/envs";

const app = new OpenAPIHono();
const supportedScopes = SCOPES.filter((scope) => !scope.startsWith("apis."));

function protectedResourceMetadata() {
  const apiUrl = getApiUrl();
  return {
    resource: apiUrl,
    authorization_servers: [apiUrl],
    scopes_supported: supportedScopes,
    resource_documentation: `${apiUrl}/`,
  };
}

// Both discovery shapes must identify this installation, including a non-default port.
app.get("/oauth-protected-resource/*", (c) =>
  c.json(protectedResourceMetadata()),
);
app.get("/oauth-protected-resource", (c) =>
  c.json(protectedResourceMetadata()),
);
app.get("/oauth-authorization-server", (c) => {
  const apiUrl = getApiUrl();
  const dashboardUrl = getAppUrl();
  return c.json({
    issuer: apiUrl,
    authorization_endpoint: `${dashboardUrl}/oauth/authorize`,
    token_endpoint: `${apiUrl}/oauth/token`,
    registration_endpoint: `${apiUrl}/oauth/register`,
    revocation_endpoint: `${apiUrl}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: supportedScopes,
  });
});

export { app as wellKnownRouter };
