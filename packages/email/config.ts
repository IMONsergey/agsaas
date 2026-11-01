export type ProductEmailConfig = {
  from: string;
  replyTo?: string;
  appUrl: string;
  productName: string;
};

export class ProductEmailConfigurationError extends Error {
  constructor(readonly code: "identity_unavailable" | "transport_unavailable") {
    super("Product email is not configured");
    this.name = "ProductEmailConfigurationError";
  }
}

function ownMailbox(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Mailbox configuration must reject control characters to prevent header injection.
  if (!value || value.length > 320 || /[\u0000-\u001f\u007f]/.test(value))
    return false;
  const address = value.includes("<")
    ? value.match(/^[^<>]+<([^<>]+)>$/)?.[1]
    : value;
  return Boolean(
    address &&
      /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) &&
      !/@(?:[^@.]+\.)*midday\.ai$/i.test(address),
  );
}

/** Validate new product-mail identity before rendering an envelope. This never
 * changes an already persisted request or requires credentials at module load. */
export function getProductEmailConfig(
  env: Record<string, string | undefined> = process.env,
): ProductEmailConfig {
  const fail = (): never => {
    throw new ProductEmailConfigurationError("identity_unavailable");
  };
  // Keep deployments which configured the earlier invitation-only name working.
  const from = env.EMAIL_FROM?.trim() || env.TEAM_INVITATION_FROM?.trim() || "";
  const replyTo = env.EMAIL_REPLY_TO?.trim() || undefined;
  const productName = env.APP_NAME?.trim() || "AGSaaS";
  if (
    !ownMailbox(from) ||
    (replyTo !== undefined && !ownMailbox(replyTo)) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Product email names must not contain control characters.
    /[\u0000-\u001f\u007f]/.test(productName) ||
    productName.length > 80
  )
    return fail();
  let url: URL;
  try {
    url = new URL(env.DASHBOARD_URL?.trim() || "");
  } catch {
    return fail();
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /(^|\.)midday\.ai$/i.test(url.hostname)
  )
    return fail();
  return {
    from,
    ...(replyTo ? { replyTo } : {}),
    appUrl: url.origin,
    productName,
  };
}

export function isProductEmailTransportAvailable(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.RESEND_API_KEY?.trim());
}

export function requireProductEmailTransport(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env.RESEND_API_KEY?.trim();
  if (!key) throw new ProductEmailConfigurationError("transport_unavailable");
  return key;
}

export function getProductEmailReviewRecipient(
  env: Record<string, string | undefined> = process.env,
): string {
  const recipient = env.EMAIL_REVIEW_TO?.trim() || "";
  if (!ownMailbox(recipient))
    throw new ProductEmailConfigurationError("identity_unavailable");
  return recipient;
}

/** Incoming loops can be ignored without requiring outbound email to be enabled. */
export function isProductEmailSender(
  address: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    const from = getProductEmailConfig(env).from;
    const mailbox = from.match(/<([^<>]+)>$/)?.[1] ?? from;
    return address.trim().toLowerCase() === mailbox.toLowerCase();
  } catch {
    return false;
  }
}

/** Provider acceptance is not mailbox delivery. Do not expose SDK response
 * text: it may include recipient addresses, headers or rendered content. */
export class ProductEmailReceiptError extends Error {
  constructor(readonly status: "rejected" | "uncertain") {
    super(`Product email provider acceptance is ${status}`);
    this.name = "ProductEmailReceiptError";
  }
}

export function requireProductEmailReceipt(response: unknown): string {
  const value = response as
    | {
        data?: { id?: unknown } | null;
        error?: { statusCode?: unknown } | null;
      }
    | undefined;
  if (value?.error) {
    const status = value.error.statusCode;
    throw new ProductEmailReceiptError(
      typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408
        ? "rejected"
        : "uncertain",
    );
  }
  if (
    typeof value?.data?.id !== "string" ||
    !value.data.id.trim() ||
    value.data.id.length > 256
  )
    throw new ProductEmailReceiptError("uncertain");
  return value.data.id;
}

export function requireProductEmailBatchReceipt(
  response: unknown,
  expected: number,
): string[] {
  const value = response as
    | {
        data?: { data?: Array<{ id?: unknown }> } | null;
        error?: { statusCode?: unknown } | null;
      }
    | undefined;
  if (value?.error) requireProductEmailReceipt(value);
  const ids = value?.data?.data?.map((item) => item.id);
  if (
    !ids ||
    ids.length !== expected ||
    new Set(ids).size !== expected ||
    ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)
  )
    throw new ProductEmailReceiptError("uncertain");
  return ids as string[];
}
