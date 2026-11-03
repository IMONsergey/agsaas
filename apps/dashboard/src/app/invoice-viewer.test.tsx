import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Socket } from "node:net";
import { searchParamsToUrlQuery } from "next/dist/shared/lib/router/utils/querystring";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotificationHandler } from "../../../../packages/notifications/src/base";

const origin = "https://app.agsaas.example.test";
const token = "invoice-access-fixture-token";
const invoiceId = "f7899b15-a2e4-4db2-9d46-ce1bfaf3a534";
const teamId = "7eaf4233-a7c8-4d34-abaf-5bb1c4f2398d";
const customerEmail = "recipient@example.test";
const invoiceNumber = "INV-VIEWER-FIXTURE";
const invoice = {
  id: invoiceId,
  invoiceNumber,
  customerName: "Viewer fixture",
  customer: {
    name: "Viewer fixture",
    email: customerEmail,
    portalEnabled: false,
  },
  template: { size: "a4", paymentEnabled: false },
  team: { name: "Fixture team", stripeConnected: false },
  amount: 125,
  currency: "USD",
  status: "unpaid",
};
const sender = {
  id: "f1a64b12-55b0-4c29-8f7e-56fc0e28b8ae",
  full_name: "Fixture sender",
  email: "sender@example.test",
  team_id: teamId,
  locale: "en",
};
const team = { id: teamId, name: "Fixture team", inboxId: teamId };
let events: string[] = [];
let updates: Array<{
  table: string;
  values: { viewed_at: string };
  column: string;
  id: string;
}> = [];
const invoiceLookup = mock(async (input: { token: string }) => {
  events.push("invoice-token-lookup");
  return input.token === token ? invoice : null;
});
const createAdmin = mock(async (_options: { admin: boolean }) => {
  events.push("viewed-at-client");
  return {
    from: (table: string) => ({
      update: (values: { viewed_at: string }) => ({
        eq: (column: string, id: string) => {
          updates.push({ table, values, column, id });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
});
const notFound = mock((): never => {
  throw new Error("INVOICE_NOT_FOUND");
});
const forbidden = (): never => {
  throw new Error("External IO is forbidden in the public invoice viewer test");
};
const priorFetch = globalThis.fetch;
const priorConnect = Socket.prototype.connect;
const priorKey = process.env.MIDDAY_ENCRYPTION_KEY;

mock.module("server-only", () => ({}));
mock.module("@/trpc/server", () => ({
  getQueryClient: () => ({ fetchQuery: invoiceLookup }),
  trpc: {
    invoice: {
      getInvoiceByToken: {
        queryOptions: (input: { token: string }) => input,
      },
    },
  },
}));
mock.module("@midday/supabase/server", () => ({ createClient: createAdmin }));
mock.module("next/navigation", () => ({ notFound }));
mock.module("@/components/invoice-view-wrapper", () => ({
  InvoiceViewWrapper: ({ children }: { children: ReactNode }) =>
    createElement("section", null, children),
}));
mock.module("@midday/invoice/templates/html", () => ({
  HtmlTemplate: ({ data }: { data: { invoiceNumber: string } }) =>
    createElement("p", null, data.invoiceNumber),
}));
mock.module("@midday/utils/envs", () => ({ getAppUrl: () => origin }));
mock.module("@midday/email/locales", () => ({
  getI18n: () => ({ t: (key: string) => key }),
}));

let Page: typeof import("./[locale]/(public)/i/[token]/page").default;
let invoiceSent: typeof import("../../../../packages/notifications/src/types/invoice-sent").invoiceSent;
let invoiceReminderSent: typeof import("../../../../packages/notifications/src/types/invoice-reminder-sent").invoiceReminderSent;
beforeAll(async () => {
  // Real producer encryption/decryption uses only this disposable fixture key.
  process.env.MIDDAY_ENCRYPTION_KEY = "3b".repeat(32);
  globalThis.fetch = Object.assign(async () => forbidden(), {
    preconnect: forbidden,
  });
  Socket.prototype.connect = forbidden;
  Page = (await import("./[locale]/(public)/i/[token]/page")).default;
  ({ invoiceSent } = await import(
    "../../../../packages/notifications/src/types/invoice-sent"
  ));
  ({ invoiceReminderSent } = await import(
    "../../../../packages/notifications/src/types/invoice-reminder-sent"
  ));
});
beforeEach(() => {
  events = [];
  updates = [];
  invoiceLookup.mockClear();
  createAdmin.mockClear();
  notFound.mockClear();
});
afterAll(() => {
  globalThis.fetch = priorFetch;
  Socket.prototype.connect = priorConnect;
  if (priorKey === undefined) delete process.env.MIDDAY_ENCRYPTION_KEY;
  else process.env.MIDDAY_ENCRYPTION_KEY = priorKey;
  mock.restore();
});

function producerUrl(handler: NotificationHandler, email = customerEmail) {
  if (!handler.createEmail)
    throw new Error("Invoice email producer is missing");
  const data = handler.schema.parse({
    users: [sender],
    invoiceId,
    token,
    invoiceNumber,
    customerName: "Viewer fixture",
    customerEmail: email,
  });
  // This builds an envelope only; it never invokes the delivery service.
  const envelope = handler.createEmail(data, sender, team);
  if (typeof envelope.data.link !== "string")
    throw new Error("Invoice producer did not return its public link");
  return new URL(envelope.data.link);
}
async function render(url: URL, invoiceToken = token) {
  const page = await Page({
    params: Promise.resolve({ token: invoiceToken }),
    // Exercise the installed Next conversion, including decoded strings/arrays.
    searchParams: Promise.resolve(searchParamsToUrlQuery(url.searchParams)),
  });
  await Promise.resolve();
  return renderToStaticMarkup(page);
}
function expectUntrackedInvoice(html: string) {
  expect(html).toContain(invoiceNumber);
  expect(invoiceLookup).toHaveBeenCalledTimes(1);
  expect(invoiceLookup).toHaveBeenCalledWith({ token });
  expect(notFound).not.toHaveBeenCalled();
  expect(createAdmin).not.toHaveBeenCalled();
  expect(updates).toEqual([]);
}

describe("public invoice Page ignores invalid optional viewer parameters", () => {
  test("an absent viewer still renders the token-authorized invoice", async () => {
    expectUntrackedInvoice(await render(new URL("/i/" + token, origin)));
  });

  test.each([
    "%25",
    "%ZZ",
    "%E0%A4%A",
  ])("a malformed percent value cannot fail before invoice lookup: %s", async (encoded) => {
    const url = new URL("/i/" + token + "?viewer=" + encoded, origin);
    expectUntrackedInvoice(await render(url));
  });

  test("duplicate viewer keys are ignored even when the first is a valid producer value", async () => {
    const url = producerUrl(invoiceSent);
    url.searchParams.append("viewer", "%");
    expect(Array.isArray(searchParamsToUrlQuery(url.searchParams).viewer)).toBe(
      true,
    );
    expectUntrackedInvoice(await render(url));
  });

  for (const kind of ["sent", "reminder"] as const) {
    test(
      "the real " + kind + " producer output still records the matching viewer",
      async () => {
        const url = producerUrl(
          kind === "sent" ? invoiceSent : invoiceReminderSent,
        );
        const html = await render(url);
        expect(html).toContain(invoiceNumber);
        expect(invoiceLookup).toHaveBeenCalledWith({ token });
        expect(createAdmin).toHaveBeenCalledTimes(1);
        expect(createAdmin).toHaveBeenCalledWith({ admin: true });
        expect(events).toEqual(["invoice-token-lookup", "viewed-at-client"]);
        expect(updates).toHaveLength(1);
        expect(updates[0]).toEqual({
          table: "invoices",
          values: { viewed_at: expect.any(String) },
          column: "id",
          id: invoiceId,
        });
        expect(Number.isFinite(Date.parse(updates[0]!.values.viewed_at))).toBe(
          true,
        );
      },
    );
  }

  test("a valid encrypted viewer for another customer does not record a view", async () => {
    expectUntrackedInvoice(
      await render(producerUrl(invoiceSent, "another@example.test")),
    );
  });

  test("a valid viewer never substitutes for a rejected invoice token", async () => {
    const url = producerUrl(invoiceSent);
    await expect(render(url, "invalid-invoice-token")).rejects.toThrow(
      "INVOICE_NOT_FOUND",
    );
    expect(invoiceLookup).toHaveBeenCalledWith({
      token: "invalid-invoice-token",
    });
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(createAdmin).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
