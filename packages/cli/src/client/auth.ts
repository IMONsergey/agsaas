import * as crypto from "node:crypto";
import chalk from "chalk";
import open from "open";
import {
  clearCredentials,
  getCredentials,
  saveCredentials,
} from "../config/store.js";
import { getApiUrl, getDashboardUrl } from "../utils/env.js";
import { startCallbackServer } from "./callback.js";

const CLIENT_NAME = "AGSaaS CLI";
const SCOPES = [
  "transactions.read",
  "transactions.write",
  "invoices.read",
  "invoices.write",
  "customers.read",
  "customers.write",
  "bank-accounts.read",
  "tracker-projects.read",
  "tracker-projects.write",
  "tracker-entries.read",
  "tracker-entries.write",
  "documents.read",
  "documents.write",
  "inbox.read",
  "inbox.write",
  "tags.read",
  "tags.write",
  "reports.read",
  "teams.read",
  "users.read",
  "search.read",
];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}

interface UserResponse {
  id?: string;
  email?: string;
  team?: { id?: string; name?: string } | null;
}

async function fetchJson<T>(
  apiOrigin: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiOrigin + path, {
    ...options,
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      "Authentication request failed (HTTP " + response.status + ")",
    );
  }
  return (await response.json()) as T;
}

async function registerClient(
  apiUrl: string,
  redirectUri: string,
): Promise<string> {
  const data = await fetchJson<{ client_id?: unknown }>(
    apiUrl,
    "/oauth/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
  );
  if (typeof data?.client_id !== "string" || !data.client_id) {
    throw new Error("The installation returned an invalid OAuth client");
  }
  return data.client_id;
}

async function exchangeCode(
  apiUrl: string,
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const data = await fetchJson<TokenResponse>(apiUrl, "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });
  if (
    !data ||
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    (data.expires_in !== undefined &&
      (typeof data.expires_in !== "number" ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0))
  ) {
    throw new Error("The installation returned invalid OAuth credentials");
  }
  return data;
}

export async function loginWithBrowser(
  opts: { noBrowser?: boolean; apiUrl?: string } = {},
): Promise<void> {
  const apiUrl = getApiUrl(opts.apiUrl);
  const dashboardUrl = getDashboardUrl();
  const state = crypto.randomBytes(32).toString("hex");
  const callback = await startCallbackServer(state);
  try {
    const redirectUri = "http://127.0.0.1:" + callback.port + "/callback";
    const clientId = await registerClient(apiUrl, redirectUri);
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const authUrl = new URL(dashboardUrl + "/oauth/authorize");
    for (const [name, value] of Object.entries({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      authUrl.searchParams.set(name, value);

    if (opts.noBrowser) {
      console.log("\n  Open this URL in your browser:\n");
      console.log("  " + chalk.cyan(authUrl.toString()) + "\n");
    } else {
      console.log("\n  " + chalk.dim("Opening browser for authentication..."));
      await open(authUrl.toString());
    }
    console.log("  " + chalk.dim("Waiting for authorization...") + "\n");
    const code = await callback.code;
    const tokens = await exchangeCode(
      apiUrl,
      clientId,
      code,
      verifier,
      redirectUri,
    );
    const credentials = {
      apiOrigin: apiUrl,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:
        tokens.expires_in === undefined
          ? undefined
          : Date.now() + tokens.expires_in * 1000,
    };
    saveCredentials(credentials);
    let user: UserResponse | undefined;
    try {
      user = await fetchJson<UserResponse>(apiUrl, "/users/me", {
        headers: { Authorization: "Bearer " + tokens.access_token },
      });
    } catch {
      // Identity metadata is optional; the bound access token has already been saved.
    }
    if (user)
      saveCredentials({
        ...credentials,
        email: user.email,
        teamName: user.team?.name,
        teamId: user.team?.id,
        userId: user.id,
      });
  } finally {
    callback.close();
  }
}

export async function loginWithToken(
  token: string,
  opts: { apiUrl?: string } = {},
): Promise<void> {
  const apiUrl = getApiUrl(opts.apiUrl);
  if (!token || token.length > 32768 || /\s/.test(token))
    throw new Error("Invalid API key");
  const user = await fetchJson<UserResponse>(apiUrl, "/users/me", {
    headers: { Authorization: "Bearer " + token },
  });
  saveCredentials({
    apiOrigin: apiUrl,
    accessToken: token,
    email: user?.email,
    teamName: user?.team?.name,
    teamId: user?.team?.id,
    userId: user?.id,
  });
}

export function logout(): void {
  clearCredentials();
}

export function getAuthStatus(apiUrl?: string): {
  loggedIn: boolean;
  email?: string;
  teamName?: string;
} {
  const credentials = getCredentials(apiUrl);
  if (!credentials) return { loggedIn: false };
  return {
    loggedIn: true,
    email: credentials.email,
    teamName: credentials.teamName,
  };
}
