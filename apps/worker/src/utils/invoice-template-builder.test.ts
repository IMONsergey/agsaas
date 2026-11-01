import { describe, expect, test } from "bun:test";
import {
  buildInvoiceTemplateFromRecurring,
  type RecurringInvoiceData,
  validateRecurringDataIntegrity,
} from "./invoice-template-builder";

function recurring(
  overrides: Partial<RecurringInvoiceData> = {},
): RecurringInvoiceData {
  return {
    teamId: "retained-team",
    userId: "historical-author",
    customerId: "customer",
    customerName: "Customer",
    template: { sendCopy: true },
    templateId: null,
    timezone: "Europe/Moscow",
    currency: "RUB",
    dueDateOffset: 30,
    paymentDetails: null,
    fromDetails: null,
    noteDetails: null,
    topBlock: null,
    bottomBlock: null,
    vat: null,
    tax: null,
    discount: null,
    subtotal: 100,
    amount: 100,
    lineItems: [{ name: "Service", quantity: 1, price: 100 }],
    ...overrides,
  };
}

describe("team-owned recurring invoice templates", () => {
  test("a deleted historical author does not invalidate the company's series", () => {
    const data = recurring({ userId: null });
    expect(validateRecurringDataIntegrity(data)).toEqual({
      isValid: true,
      errors: [],
    });
    expect(buildInvoiceTemplateFromRecurring(data)).toMatchObject({
      currency: "RUB",
      timezone: "Europe/Moscow",
      deliveryType: "create_and_send",
    });
    expect(data.userId).toBeNull();
  });

  test("a live author remains valid without changing template output", () => {
    expect(validateRecurringDataIntegrity(recurring()).isValid).toBe(true);
    expect(buildInvoiceTemplateFromRecurring(recurring())).toEqual(
      buildInvoiceTemplateFromRecurring(recurring({ userId: null })),
    );
  });

  test("missing or malformed author metadata is not treated as explicit anonymization", () => {
    for (const userId of [undefined, "", 42]) {
      // Exercise runtime corruption, not a supported public API input.
      const data = {
        ...recurring(),
        userId,
      } as unknown as RecurringInvoiceData;
      expect(validateRecurringDataIntegrity(data)).toEqual({
        isValid: false,
        errors: ["Invalid userId"],
      });
    }
  });

  test("nullable author does not bypass required team and schedule validation", () => {
    expect(
      validateRecurringDataIntegrity(
        recurring({
          userId: null,
          teamId: "",
          timezone: "",
          dueDateOffset: Number.NaN,
        }),
      ),
    ).toEqual({
      isValid: false,
      errors: ["Missing teamId", "Missing timezone", "Invalid dueDateOffset"],
    });
  });
});
