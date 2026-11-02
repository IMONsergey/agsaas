import { mock } from "bun:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";

// Each child loads actual actions/adapter. Only framework authentication and
// HTTP responses are replaced. No real credential or network is available.
const scenario = process.argv[2]!;
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "fixture@example.test",
  fullName: "Fixture User",
};
const apiKey = "plainApiKey_fixture_not_a_real_credential";
const endpoint = "https://core-api.uk.plain.com/graphql/v1";
const supportInput = {
  subject: "Fixture subject",
  priority: "high" as const,
  type: "General" as const,
  message: "Fixture message",
  url: "https://dashboard.example.test/settings",
};
let networkAttempts = 0;
const forbidden = (): never => {
  networkAttempts++;
  throw new Error("Real network forbidden in Plain fixture");
};
Socket.prototype.connect = forbidden;
Bun.connect = forbidden;
mock.module("server-only", () => ({}));
mock.module("@/actions/safe-action", () => ({
  authActionClient: {
    schema: (schema: { parse: (input: unknown) => unknown }) => ({
      metadata: () => ({
        action:
          (
            handler: (args: {
              parsedInput: unknown;
              ctx: { user: typeof user };
            }) => Promise<unknown>,
          ) =>
          async (input: unknown) =>
            handler({ parsedInput: schema.parse(input), ctx: { user } }),
      }),
    }),
  },
}));

const originalTimeout = AbortSignal.timeout;
const timeouts: number[] = [];
const abort = new AbortController();
AbortSignal.timeout = (milliseconds: number) => {
  timeouts.push(milliseconds);
  return scenario === "timeout" || scenario === "body-timeout"
    ? abort.signal
    : originalTimeout(milliseconds);
};
const requests: Array<{
  query: string;
  operationName: string;
  variables: { input: Record<string, unknown> };
  signal: AbortSignal | null | undefined;
}> = [];
const success = (customer: boolean) =>
  Response.json({
    data: customer
      ? { upsertCustomer: { customer: { id: "c_fixture" }, error: null } }
      : { createThread: { thread: { id: "th_fixture" }, error: null } },
  });
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), endpoint);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
    assert.equal(headers.get("content-type"), "application/json");
    assert(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body));
    requests.push({ ...body, signal: init?.signal });
    const customer = body.operationName === "AGSaaSUpsertSupportCustomer";
    assert.equal(
      body.query.replace(/\s+/g, " ").trim(),
      customer
        ? "mutation AGSaaSUpsertSupportCustomer($input: UpsertCustomerInput!) { upsertCustomer(input: $input) { customer { id } error { __typename } } }"
        : "mutation AGSaaSCreateSupportThread($input: CreateThreadInput!) { createThread(input: $input) { thread { id } error { __typename } } }",
    );
    assert(
      !body.query.includes(supportInput.message),
      "User content belongs in variables, never interpolated GraphQL",
    );
    if (scenario === "timeout") {
      abort.abort();
      throw new Error("PRIVATE_ABORT_DETAIL");
    }
    if (customer) {
      if (scenario === "http-unauthorized")
        return new Response("PRIVATE_AUTH_DETAIL", { status: 401 });
      if (scenario === "customer-error")
        return Response.json({
          data: {
            upsertCustomer: {
              customer: { id: "c_fixture" },
              error: { message: "PRIVATE_MUTATION_DETAIL" },
            },
          },
        });
      if (scenario === "customer-missing-id")
        return Response.json({
          data: { upsertCustomer: { customer: null, error: null } },
        });
      return success(true);
    }
    if (scenario === "thread-error")
      return Response.json({
        data: {
          createThread: {
            thread: { id: "th_fixture" },
            error: { message: "PRIVATE_MUTATION_DETAIL" },
          },
        },
      });
    if (scenario === "thread-missing-id")
      return Response.json({
        data: { createThread: { thread: {}, error: null } },
      });
    if (scenario === "graphql-error")
      return Response.json({
        data: { createThread: { thread: { id: "th_fixture" }, error: null } },
        errors: [{ message: "PRIVATE_GRAPHQL_DETAIL" }],
      });
    if (scenario === "http-rate-limit")
      return new Response("PRIVATE_PROVIDER_DETAIL", { status: 429 });
    if (scenario === "http-server-error")
      return new Response("PRIVATE_PROVIDER_DETAIL", { status: 500 });
    if (scenario === "invalid-json")
      return new Response("PRIVATE_INVALID_JSON");
    if (scenario === "oversize-body")
      return new Response("a".repeat(64 * 1024 + 1));
    if (scenario === "transport-throw")
      throw new Error(`PRIVATE_TRANSPORT_DETAIL ${apiKey}`);
    if (scenario === "body-timeout")
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("PRIVATE_BODY_ABORT_DETAIL")),
              { once: true },
            );
            queueMicrotask(() => abort.abort());
          },
        }),
      );
    return success(false);
  },
  { preconnect: forbidden },
);

const deadline = setTimeout(() => process.exit(124), 8000);
try {
  // No key exists during import, proving there is no eager SDK constructor.
  delete process.env.PLAIN_API_KEY;
  const { sendSupportAction } = await import(
    "../../actions/send-support-action"
  );
  const { sendFeebackAction } = await import(
    "../../actions/send-feedback-action"
  );
  assert.equal(requests.length, 0);
  if (!scenario.endsWith("-unconfigured")) process.env.PLAIN_API_KEY = apiKey;
  if (scenario !== "no-labels") {
    process.env.PLAIN_SUPPORT_LABEL_ID = "lt_own_support";
    process.env.PLAIN_FEEDBACK_LABEL_ID = "lt_own_feedback";
  }
  if (scenario === "invalid-label")
    process.env.PLAIN_SUPPORT_LABEL_ID = "PRIVATE_INVALID_LABEL\nheader";
  const feedback = scenario.startsWith("feedback-");
  const invoke = () =>
    feedback
      ? sendFeebackAction({ feedback: "Fixture feedback" })
      : sendSupportAction(supportInput);
  const successful = [
    "support-success",
    "feedback-success",
    "no-labels",
    "priorities",
    "lazy-key",
  ].includes(scenario);
  if (scenario === "validation") {
    for (const input of [
      { ...supportInput, subject: " " },
      { ...supportInput, subject: "x".repeat(201) },
      { ...supportInput, message: "x".repeat(10_001) },
      { ...supportInput, priority: "other" },
      { ...supportInput, type: "other" },
      { ...supportInput, url: "javascript:alert(1)" },
      { ...supportInput, url: "https://secret:password@example.test" },
    ])
      await assert.rejects(sendSupportAction(input as typeof supportInput));
    await assert.rejects(sendFeebackAction({ feedback: "" }));
    await assert.rejects(sendFeebackAction({ feedback: "x".repeat(10_001) }));
    assert.equal(requests.length, 0);
    assert.equal(timeouts.length, 0);
  } else if (successful) {
    assert.deepEqual(await invoke(), { accepted: true });
    assert.equal(requests.length, 2);
    assert.deepEqual(timeouts, [8000]);
    assert.equal(
      requests[0]!.signal,
      requests[1]!.signal,
      "Both mutations share one total timeout budget",
    );
    assert.deepEqual(requests[0]!.variables, {
      input: {
        identifier: { externalId: user.id },
        onCreate: {
          externalId: user.id,
          fullName: user.fullName,
          email: { email: user.email, isVerified: false },
        },
        onUpdate: {},
      },
    });
    assert.deepEqual(requests[1]!.variables, {
      input: {
        title: feedback ? "Feedback" : supportInput.subject,
        customerIdentifier: { customerId: "c_fixture" },
        priority: feedback ? 2 : 1,
        labelTypeIds:
          scenario === "no-labels"
            ? []
            : [feedback ? "lt_own_feedback" : "lt_own_support"],
        components: feedback
          ? [{ componentText: { text: "Fixture feedback" } }]
          : [
              { componentText: { text: supportInput.message } },
              { componentText: { text: "Product: General" } },
              { componentText: { text: `Page: ${supportInput.url}` } },
            ],
      },
    });
    if (scenario === "priorities") {
      for (const [priority, number] of [
        ["urgent", 0],
        ["high", 1],
        ["normal", 2],
        ["low", 3],
      ] as const) {
        assert.deepEqual(
          await sendSupportAction({ ...supportInput, priority }),
          { accepted: true },
        );
        assert.equal(requests.at(-1)!.variables.input.priority, number);
      }
    }
    assert(!JSON.stringify(requests).includes("lt_01HV93GFTZAKESXMVY8X371ADG"));
  } else {
    let failure: unknown;
    try {
      await invoke();
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error);
    assert(!failure.message.includes("PRIVATE_"));
    assert(!failure.message.includes(apiKey));
    if (scenario.endsWith("-unconfigured") || scenario === "invalid-label") {
      assert.equal(
        failure.message,
        "Support messaging is not configured for this installation.",
      );
      assert.equal(requests.length, 0);
    } else {
      const early = [
        "customer-error",
        "customer-missing-id",
        "http-unauthorized",
        "timeout",
      ].includes(scenario);
      assert.equal(
        requests.length,
        early ? 1 : 2,
        "Failed mutations are never automatically repeated",
      );
      assert.deepEqual(timeouts, [8000]);
      if (
        [
          "customer-error",
          "thread-error",
          "http-unauthorized",
          "http-rate-limit",
        ].includes(scenario)
      )
        assert(failure.message.includes("could not accept"));
      else assert(failure.message.includes("could not confirm"));
    }
  }
  assert.equal(networkAttempts, 0);
  console.log(`PLAIN_SUPPORT_OK ${scenario} networkAttempts=0`);
} finally {
  AbortSignal.timeout = originalTimeout;
  clearTimeout(deadline);
}
