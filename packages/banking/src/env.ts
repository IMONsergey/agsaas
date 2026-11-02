import { createEnv, type StandardSchemaV1 } from "@t3-oss/env-core";
import { z } from "zod";

type RuntimeEnvironment = Record<string, string | undefined>;

function reportInvalidEnvironment(group: string) {
  return (issues: readonly StandardSchemaV1.Issue[]): never => {
    const fields = issues.flatMap((issue) => {
      const part = issue.path?.[0];
      if (part === undefined) return [];
      return [String(typeof part === "object" ? part.key : part)];
    });

    // Do not log validator issues or values: these fields contain credentials.
    throw new Error(
      `Missing or invalid ${group} environment variables: ${[...new Set(fields)].join(", ")}`,
    );
  };
}

function lazy<T>(initialize: () => T): () => T {
  let value: T | undefined;
  return () => {
    // Cache only a successful validation, keeping each provider configuration
    // stable after first use. A failed validation can be retried after setup.
    value ??= initialize();
    return value;
  };
}

/**
 * Importing banking must not require credentials for every optional provider.
 * Validate a complete provider group on first access, preserving the original
 * field constraints and createEnv's server-only access protection.
 */
export function createBankingEnvironment(
  runtimeEnv: RuntimeEnvironment,
  options: { isServer?: boolean } = {},
) {
  const shared = { runtimeEnv, isServer: options.isServer };
  const plaid = lazy(() =>
    createEnv({
      ...shared,
      server: {
        PLAID_CLIENT_ID: z.string().min(1),
        PLAID_SECRET: z.string().min(1),
        PLAID_ENVIRONMENT: z.string().default("production"),
      },
      onValidationError: reportInvalidEnvironment("Plaid"),
    }),
  );
  const goCardless = lazy(() =>
    createEnv({
      ...shared,
      server: {
        GOCARDLESS_SECRET_ID: z.string().min(1),
        GOCARDLESS_SECRET_KEY: z.string().min(1),
      },
      onValidationError: reportInvalidEnvironment("GoCardless"),
    }),
  );
  const enableBanking = lazy(() =>
    createEnv({
      ...shared,
      server: {
        ENABLEBANKING_APPLICATION_ID: z.string().min(1),
        ENABLE_BANKING_KEY_CONTENT: z.string().min(1),
        ENABLEBANKING_REDIRECT_URL: z.string().min(1),
      },
      onValidationError: reportInvalidEnvironment("EnableBanking"),
    }),
  );
  const teller = lazy(() =>
    createEnv({
      ...shared,
      server: {
        TELLER_CERT_BASE64: z.string().min(1),
        TELLER_KEY_BASE64: z.string().min(1),
      },
      onValidationError: reportInvalidEnvironment("Teller"),
    }),
  );
  const r2 = lazy(() =>
    createEnv({
      ...shared,
      server: {
        R2_ENDPOINT: z.string().url(),
        R2_ACCESS_KEY_ID: z.string().min(1),
        R2_SECRET_ACCESS_KEY: z.string().min(1),
        R2_BUCKET_NAME: z.string().min(1),
      },
      onValidationError: reportInvalidEnvironment("R2"),
    }),
  );
  const logoDev = lazy(() =>
    createEnv({
      ...shared,
      server: {
        LOGO_DEV_TOKEN: z.string().min(1),
      },
      onValidationError: reportInvalidEnvironment("logo.dev"),
    }),
  );

  return {
    get PLAID_CLIENT_ID() {
      return plaid().PLAID_CLIENT_ID;
    },
    get PLAID_SECRET() {
      return plaid().PLAID_SECRET;
    },
    get PLAID_ENVIRONMENT() {
      return plaid().PLAID_ENVIRONMENT;
    },
    get GOCARDLESS_SECRET_ID() {
      return goCardless().GOCARDLESS_SECRET_ID;
    },
    get GOCARDLESS_SECRET_KEY() {
      return goCardless().GOCARDLESS_SECRET_KEY;
    },
    get ENABLEBANKING_APPLICATION_ID() {
      return enableBanking().ENABLEBANKING_APPLICATION_ID;
    },
    get ENABLE_BANKING_KEY_CONTENT() {
      return enableBanking().ENABLE_BANKING_KEY_CONTENT;
    },
    get ENABLEBANKING_REDIRECT_URL() {
      return enableBanking().ENABLEBANKING_REDIRECT_URL;
    },
    get TELLER_CERT_BASE64() {
      return teller().TELLER_CERT_BASE64;
    },
    get TELLER_KEY_BASE64() {
      return teller().TELLER_KEY_BASE64;
    },
    get R2_ENDPOINT() {
      return r2().R2_ENDPOINT;
    },
    get R2_ACCESS_KEY_ID() {
      return r2().R2_ACCESS_KEY_ID;
    },
    get R2_SECRET_ACCESS_KEY() {
      return r2().R2_SECRET_ACCESS_KEY;
    },
    get R2_BUCKET_NAME() {
      return r2().R2_BUCKET_NAME;
    },
    get LOGO_DEV_TOKEN() {
      return logoDev().LOGO_DEV_TOKEN;
    },
  };
}

export const env = createBankingEnvironment(process.env);
