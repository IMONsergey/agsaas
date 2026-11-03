import { hostedPlaidCapability } from "@api/services/plaid-hosted-consent";
import {
  BANK_CONSENT_ONBOARDING_READY,
  BANK_CONSENT_UNAVAILABLE_REASON,
} from "./bank-consent-policy";
import {
  getProductEmailConfig,
  isProductEmailTransportAvailable,
} from "@midday/email/config";

type Environment = Record<string, string | undefined>;
export type IntegrationCapability = { enabled: boolean; reason: string | null };

/** Public configuration status only. Never return environment values or keys. */
export function getInstanceCapabilities(env: Environment = process.env) {
  const has = (...keys: string[]) => keys.every((key) => !!env[key]?.trim());
  const capability = (
    enabled: boolean,
    reason = "Not configured for this installation",
  ): IntegrationCapability => ({ enabled, reason: enabled ? null : reason });
  let emailConfigured = false;
  try {
    getProductEmailConfig(env);
    emailConfigured = isProductEmailTransportAvailable(env);
  } catch {}
  const integrations: Record<string, IntegrationCapability> = {
    gmail: capability(
      has("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REDIRECT_URI"),
    ),
    outlook: capability(
      has("OUTLOOK_CLIENT_ID", "OUTLOOK_CLIENT_SECRET", "OUTLOOK_REDIRECT_URI"),
    ),
    slack: capability(
      has("SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"),
    ),
    telegram: capability(has("TELEGRAM_BOT_TOKEN")),
    whatsapp: capability(
      has(
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_APP_SECRET",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_VERIFY_TOKEN",
      ),
    ),
    sendblue: capability(
      has("SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER"),
    ),
    quickbooks: capability(
      has(
        "QUICKBOOKS_CLIENT_ID",
        "QUICKBOOKS_CLIENT_SECRET",
        "QUICKBOOKS_OAUTH_REDIRECT_URL",
      ),
    ),
    xero: capability(
      has("XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_OAUTH_REDIRECT_URL"),
    ),
    fortnox: capability(
      has(
        "FORTNOX_CLIENT_ID",
        "FORTNOX_CLIENT_SECRET",
        "FORTNOX_OAUTH_REDIRECT_URL",
      ),
    ),
    "stripe-payments": capability(
      has(
        "STRIPE_SECRET_KEY",
        "STRIPE_CONNECT_CLIENT_ID",
        "STRIPE_CONNECT_WEBHOOK_SECRET",
      ),
    ),
    "midday-desktop": capability(
      false,
      "Desktop distribution is not configured for this installation",
    ),
    "e-invoice": capability(false, "Not available for this installation"),
  };
  const bankProvider =
    has("PLAID_CLIENT_ID", "PLAID_SECRET") ||
    has("GOCARDLESS_SECRET_ID", "GOCARDLESS_SECRET_KEY") ||
    has("TELLER_APPLICATION_ID", "TELLER_CERT_BASE64", "TELLER_KEY_BASE64") ||
    has(
      "ENABLEBANKING_APPLICATION_ID",
      "ENABLE_BANKING_KEY_CONTENT",
      "ENABLEBANKING_REDIRECT_URL",
    );
  return {
    integrations,
    hostedBanking: hostedPlaidCapability(env),
    banking: capability(
      BANK_CONSENT_ONBOARDING_READY && bankProvider,
      BANK_CONSENT_UNAVAILABLE_REASON,
    ),
    enrichment: capability(
      has("COMPANY_ENRICH_API_KEY"),
      "Customer enrichment is not configured for this installation",
    ),
    ai: capability(
      has("OPENAI_API_KEY"),
      "AI assistance is not configured. All manual workspace tools remain available.",
    ),
    connectors: capability(has("COMPOSIO_API_KEY")),
    email: capability(emailConfigured),
    billing: capability(
      env.AGSAAS_BILLING_ENABLED === "true" &&
        has(
          "POLAR_ACCESS_TOKEN",
          "POLAR_WEBHOOK_SECRET",
          "POLAR_STARTER_PRODUCT_ID",
          "POLAR_STARTER_YEARLY_PRODUCT_ID",
          "POLAR_PRO_PRODUCT_ID",
          "POLAR_PRO_YEARLY_PRODUCT_ID",
        ),
      "Subscriptions are not enabled for this installation",
    ),
    support: capability(true),
  };
}
