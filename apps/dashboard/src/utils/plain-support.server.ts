import "server-only";

const endpoint = "https://core-api.uk.plain.com/graphql/v1";
const timeoutMs = 8_000;
const maxResponseBytes = 64 * 1024;

// Minimal selections from Plain's documented GraphQL mutations, also used by
// team-plain/typescript-sdk v5.12.1. Error details are deliberately not requested.
const upsertCustomerQuery = `mutation AGSaaSUpsertSupportCustomer($input: UpsertCustomerInput!) {
  upsertCustomer(input: $input) {
    customer { id }
    error { __typename }
  }
}`;
const createThreadQuery = `mutation AGSaaSCreateSupportThread($input: CreateThreadInput!) {
  createThread(input: $input) {
    thread { id }
    error { __typename }
  }
}`;

export type SupportPriority = "low" | "normal" | "high" | "urgent";
export type PlainSupportMessage = {
  kind: "support" | "feedback";
  customer: { id: string; email: string | null; fullName: string | null };
  title: string;
  message: string;
  priority?: SupportPriority;
  product?: string;
  url?: string;
};

const priorityNumbers: Record<SupportPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const messages = {
  configuration: "Support messaging is not configured for this installation.",
  input: "Check the support message and your account details before sending.",
  rejected:
    "Support messaging could not accept this request. Please contact your workspace administrator.",
  unconfirmed:
    "We could not confirm this message was created. Contact your workspace administrator before sending it again.",
};

class PlainRequestError extends Error {
  constructor(kind: keyof typeof messages) {
    super(messages[kind]);
    this.name = "PlainRequestError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\u0000")
  ) {
    throw new PlainRequestError("input");
  }
  return value.trim();
}

function optionalLabel(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const label = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(label))
    throw new PlainRequestError("configuration");
  return [label];
}

export function isSupportContextUrl(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters before URL parsing can normalize support context links.
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxResponseBytes)
    throw new PlainRequestError("unconfirmed");
  const reader = response.body?.getReader();
  if (!reader) throw new PlainRequestError("unconfirmed");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new PlainRequestError("unconfirmed");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

type CustomerInput = {
  identifier: { externalId: string };
  onCreate: {
    fullName: string;
    externalId: string;
    email: { email: string; isVerified: false };
  };
  onUpdate: Record<string, never>;
};
type ThreadInput = {
  title: string;
  customerIdentifier: { customerId: string };
  priority: number;
  labelTypeIds: string[];
  components: Array<{ componentText: { text: string } }>;
};

async function mutation(
  apiKey: string,
  signal: AbortSignal,
  operation: "customer" | "thread",
  input: CustomerInput | ThreadInput,
): Promise<string> {
  signal.throwIfAborted();
  const customer = operation === "customer";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: customer ? upsertCustomerQuery : createThreadQuery,
      operationName: customer
        ? "AGSaaSUpsertSupportCustomer"
        : "AGSaaSCreateSupportThread",
      variables: { input },
    }),
    signal,
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new PlainRequestError(
      [400, 401, 403, 404, 429].includes(response.status)
        ? "rejected"
        : "unconfirmed",
    );
  }
  const envelope = record(await readResponse(response));
  if (
    !envelope ||
    (envelope.errors !== undefined &&
      (!Array.isArray(envelope.errors) || envelope.errors.length > 0))
  ) {
    throw new PlainRequestError("unconfirmed");
  }
  const output = record(
    record(envelope.data)?.[customer ? "upsertCustomer" : "createThread"],
  );
  if (!output || !Object.hasOwn(output, "error"))
    throw new PlainRequestError("unconfirmed");
  if (output.error !== null) throw new PlainRequestError("rejected");
  const id = record(output[operation])?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new PlainRequestError("unconfirmed");
  return id;
}

/** Two fixed mutations, one 8s budget, no automatic retries or raw error logs. */
export async function sendPlainSupportMessage(
  input: PlainSupportMessage,
): Promise<{ accepted: true }> {
  // Read optional credentials at invocation, never at module import/build time.
  const apiKey = process.env.PLAIN_API_KEY?.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in credentials before constructing an authorization header.
  if (!apiKey || apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(apiKey))
    throw new PlainRequestError("configuration");
  if (input.kind !== "support" && input.kind !== "feedback")
    throw new PlainRequestError("input");
  const externalId = text(input.customer.id, 128);
  const email = text(input.customer.email, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new PlainRequestError("input");
  const fullName = input.customer.fullName?.trim()
    ? text(input.customer.fullName, 200)
    : "AGSaaS user";
  const title = text(input.title, 200);
  const message = text(input.message, 10_000);
  const priority = input.priority ?? "normal";
  if (!Object.hasOwn(priorityNumbers, priority))
    throw new PlainRequestError("input");
  const components = [{ componentText: { text: message } }];
  if (input.product)
    components.push({
      componentText: { text: `Product: ${text(input.product, 64)}` },
    });
  if (input.url) {
    if (!isSupportContextUrl(input.url)) throw new PlainRequestError("input");
    // A plain context component needs no custom field in the operator's workspace.
    components.push({ componentText: { text: `Page: ${input.url}` } });
  }
  const labelTypeIds = optionalLabel(
    input.kind === "support"
      ? process.env.PLAIN_SUPPORT_LABEL_ID
      : process.env.PLAIN_FEEDBACK_LABEL_ID,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const customerId = await mutation(apiKey, signal, "customer", {
      // Bind support identity to the authenticated application user. Editable
      // profile email is contact data, not proof of a verified email address.
      identifier: { externalId },
      onCreate: { fullName, externalId, email: { email, isVerified: false } },
      onUpdate: {},
    });
    await mutation(apiKey, signal, "thread", {
      title,
      customerIdentifier: { customerId },
      priority: priorityNumbers[priority],
      labelTypeIds,
      components,
    });
    return { accepted: true };
  } catch (error) {
    // A lost response may follow an accepted create. Do not retry or claim
    // definite rejection, and never expose keys, query variables or diagnostics.
    throw error instanceof PlainRequestError
      ? error
      : new PlainRequestError("unconfirmed");
  }
}
