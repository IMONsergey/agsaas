import {
  hostedPlaidClientBinding,
  consentIdentifier,
  type HostedConsentPayload,
  type VerifiedConsentAccount,
  validateConsentAccounts,
} from "@midday/db/bank-consent";
import { getApiUrl, getAppUrl } from "@midday/utils/envs";
import { z } from "zod";

type Environment = Record<string, string | undefined>;
export type HostedPlaidConfiguration = {
  environment: "sandbox" | "production";
  clientId: string;
  secret: string;
  clientFingerprint: string;
  dashboardOrigin: string;
  apiOrigin: string;
};

export class HostedPlaidUnavailableError extends Error {
  constructor() {
    super(
      "The bank provider could not confirm this operation. Check the connection status before trying again.",
    );
    this.name = "HostedPlaidUnavailableError";
  }
}

export function hostedPlaidConfiguration(
  env: Environment = process.env,
): HostedPlaidConfiguration {
  if (
    env.AGSAAS_PLAID_HOSTED_LINK_ENABLED !== "true" ||
    !["sandbox", "production"].includes(env.PLAID_ENVIRONMENT ?? "") ||
    !env.PLAID_CLIENT_ID?.trim() ||
    !env.PLAID_SECRET?.trim() ||
    !/^[0-9a-f]{64}$/i.test(env.MIDDAY_ENCRYPTION_KEY ?? "")
  )
    throw new HostedPlaidUnavailableError();
  const dashboardOrigin = getAppUrl(env),
    apiOrigin = getApiUrl(env);
  if (
    env.PLAID_ENVIRONMENT === "production" &&
    (!dashboardOrigin.startsWith("https://") ||
      !apiOrigin.startsWith("https://"))
  )
    throw new HostedPlaidUnavailableError();
  const binding = hostedPlaidClientBinding(env);
  if (!binding) throw new HostedPlaidUnavailableError();
  return {
    environment: binding.environment,
    clientId: env.PLAID_CLIENT_ID.trim(),
    secret: env.PLAID_SECRET.trim(),
    clientFingerprint: binding.clientFingerprint,
    dashboardOrigin,
    apiOrigin,
  };
}

export function hostedPlaidCapability(env: Environment = process.env) {
  try {
    const config = hostedPlaidConfiguration(env);
    return {
      enabled: true,
      environment: config.environment,
      countries: ["US", "CA"] as const,
      reason: null,
    };
  } catch {
    return {
      enabled: false,
      environment: null,
      countries: ["US", "CA"] as const,
      reason:
        "Plaid consent is not configured for this installation. Manual accounts and CSV imports remain available.",
    };
  }
}

const providerString = z.string().min(1).max(4096);
const linkResponse = z.object({
  link_token: providerString,
  expiration: providerString,
  hosted_link_url: z.string().url().max(8192),
});
const sessionResponse = z.object({
  link_token: providerString,
  link_sessions: z
    .array(
      z.object({
        link_session_id: providerString,
        started_at: z.string().nullable().optional(),
        finished_at: z.string().nullable().optional(),
        results: z
          .object({
            item_add_results: z
              .array(
                z.object({
                  public_token: providerString.nullable().optional(),
                }),
              )
              .max(100)
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .max(100),
});

/** Only Plaid's server response for the exact retained Link token proves the grant.
 * A callback URL, browser public_token, item ID or metadata is never proof.
 * https://plaid.com/docs/link/hosted-link/ and https://plaid.com/docs/api/link/ */
export function hostedLinkEvidence(
  value: unknown,
  input: {
    linkToken: string;
    environment: string;
    createdAt: string;
    expiresAt: string;
  },
) {
  const parsed = sessionResponse.safeParse(value);
  if (!parsed.success) throw new HostedPlaidUnavailableError();
  const result = parsed.data;
  const created = Date.parse(input.createdAt),
    expires = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    expires <= created
  )
    throw new HostedPlaidUnavailableError();
  if (result.link_token !== input.linkToken)
    throw new HostedPlaidUnavailableError();
  const matches = new Map<
    string,
    { publicToken: string; linkSessionId: string }
  >();
  for (const session of result.link_sessions) {
    if (!session.finished_at) continue;
    const finished = new Date(session.finished_at).getTime();
    if (
      !Number.isFinite(finished) ||
      finished < created - 300000 ||
      finished > expires ||
      finished > Date.now() + 300000
    )
      throw new HostedPlaidUnavailableError();
    for (const item of session.results?.item_add_results ?? []) {
      if (!item.public_token) continue;
      if (
        !item.public_token.startsWith(`public-${input.environment}-`) ||
        !consentIdentifier(item.public_token, 4096)
      )
        throw new HostedPlaidUnavailableError();
      const previous = matches.get(item.public_token);
      if (previous && previous.linkSessionId !== session.link_session_id)
        throw new HostedPlaidUnavailableError();
      matches.set(item.public_token, {
        publicToken: item.public_token,
        linkSessionId: session.link_session_id,
      });
    }
  }
  // This product command creates one connection. Never silently choose one of
  // several successful Items, even if a provider configuration changes later.
  if (matches.size > 1) throw new HostedPlaidUnavailableError();
  return matches.values().next().value ?? null;
}

export function validateHostedPlaidUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "secure.plaid.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new HostedPlaidUnavailableError();
  return url.href;
}

const accountsResponse = z.object({
  item: z.object({
    item_id: providerString,
    institution_id: providerString.nullable(),
  }),
  accounts: z
    .array(
      z.object({
        account_id: providerString,
        name: z.string().min(1).max(250),
        type: z.string().min(1).max(100),
        subtype: z.string().max(100).nullable().optional(),
        balances: z.object({ iso_currency_code: z.string().nullable() }),
      }),
    )
    .min(1)
    .max(100),
});

export function verifiedHostedPlaidAccounts(value: unknown, itemId: string) {
  const parsed = accountsResponse.safeParse(value);
  if (!parsed.success) throw new HostedPlaidUnavailableError();
  const response = parsed.data;
  if (response.item.item_id !== itemId || !response.item.institution_id)
    throw new HostedPlaidUnavailableError();
  const types: Record<string, VerifiedConsentAccount["type"]> = {
    credit: "credit",
    depository: "depository",
    loan: "loan",
    investment: "other_asset",
    other: "other_asset",
  };
  const accounts = validateConsentAccounts(
    response.accounts.map((account) => ({
      accountId: account.account_id,
      name: account.name,
      currency: account.balances.iso_currency_code,
      type: types[account.type],
      subtype: account.subtype ?? null,
    })),
  );
  return { institutionId: response.item.institution_id, accounts };
}

export type HostedPlaidFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export function createHostedPlaidTransport(
  configuration: HostedPlaidConfiguration,
  transport: HostedPlaidFetch = fetch,
) {
  const providerOrigin =
    configuration.environment === "sandbox"
      ? "https://sandbox.plaid.com"
      : "https://production.plaid.com";
  // One user command may need Link GET, exchange, accounts and institution GET.
  // They share one monotonic budget; no request starts after it has expired.
  const deadline = performance.now() + 30000;
  async function request(path: string, body: Record<string, unknown>) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new HostedPlaidUnavailableError();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(15000, remaining),
    );
    try {
      const response = await transport(`${providerOrigin}${path}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          client_id: configuration.clientId,
          secret: configuration.secret,
        }),
      });
      if (!response.ok || !response.body)
        throw new HostedPlaidUnavailableError();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > 2 * 1024 * 1024) throw new HostedPlaidUnavailableError();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      // Provider bodies and credentials never enter application diagnostics.
      throw new HostedPlaidUnavailableError();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return {
    async create(input: { id: string; country: "US" | "CA" }) {
      const result = linkResponse.parse(
        await request("/link/token/create", {
          client_name: "AGSaaS",
          country_codes: [input.country],
          language: "en",
          products: ["transactions"],
          user: { client_user_id: `agsaas-consent-${input.id}` },
          webhook: `${configuration.apiOrigin}/webhook/plaid`,
          hosted_link: {
            url_lifetime_seconds: 1800,
            completion_redirect_uri: `${configuration.dashboardOrigin}/settings/accounts?bankConsent=${encodeURIComponent(input.id)}`,
          },
        }),
      );
      if (
        !result.link_token.startsWith(`link-${configuration.environment}-`) ||
        !Number.isFinite(new Date(result.expiration).getTime())
      )
        throw new HostedPlaidUnavailableError();
      return {
        linkToken: result.link_token,
        hostedUrl: validateHostedPlaidUrl(result.hosted_link_url),
        expiresAt: result.expiration,
      };
    },
    async evidence(
      payload: HostedConsentPayload,
      row: { createdAt: string; expiresAt: string },
    ) {
      if (
        !payload.linkToken ||
        payload.environment !== configuration.environment ||
        payload.clientFingerprint !== configuration.clientFingerprint
      )
        throw new HostedPlaidUnavailableError();
      return hostedLinkEvidence(
        await request("/link/token/get", { link_token: payload.linkToken }),
        {
          linkToken: payload.linkToken,
          environment: configuration.environment,
          ...row,
        },
      );
    },
    async exchange(publicToken: string) {
      if (
        !publicToken.startsWith(`public-${configuration.environment}-`) ||
        !consentIdentifier(publicToken, 4096)
      )
        throw new HostedPlaidUnavailableError();
      const parsed = z
        .object({ access_token: providerString, item_id: providerString })
        .safeParse(
          await request("/item/public_token/exchange", {
            public_token: publicToken,
          }),
        );
      if (
        !parsed.success ||
        !parsed.data.access_token.startsWith(
          `access-${configuration.environment}-`,
        ) ||
        !consentIdentifier(parsed.data.access_token, 4096) ||
        !consentIdentifier(parsed.data.item_id)
      )
        throw new HostedPlaidUnavailableError();
      return {
        accessToken: parsed.data.access_token,
        itemId: parsed.data.item_id,
      };
    },
    async accounts(payload: HostedConsentPayload) {
      if (
        !payload.accessToken ||
        !payload.itemId ||
        payload.environment !== configuration.environment ||
        payload.clientFingerprint !== configuration.clientFingerprint
      )
        throw new HostedPlaidUnavailableError();
      const data = verifiedHostedPlaidAccounts(
        await request("/accounts/get", { access_token: payload.accessToken }),
        payload.itemId,
      );
      const institution = z
        .object({
          institution: z.object({
            institution_id: providerString,
            name: z.string().min(1).max(250),
          }),
        })
        .parse(
          await request("/institutions/get_by_id", {
            institution_id: data.institutionId,
            country_codes: [payload.country],
          }),
        );
      if (institution.institution.institution_id !== data.institutionId)
        throw new HostedPlaidUnavailableError();
      return { ...data, institutionName: institution.institution.name };
    },
  };
}
