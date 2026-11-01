import { describe, expect, test } from "bun:test";
import { invoiceDeliveryOperationKey } from "./invoice-delivery-operation";

const params = {
  teamId: "team-a",
  invoiceId: "invoice-a",
  kind: "invoice" as const,
  job: { id: "123", name: "generate-invoice", timestamp: 1793448000000 },
};

describe("invoice delivery operation identity", () => {
  test("a retry keeps the same deterministic key", () => {
    expect(invoiceDeliveryOperationKey(params)).toBe(
      invoiceDeliveryOperationKey(structuredClone(params)),
    );
    expect(invoiceDeliveryOperationKey(params)).toMatch(/^[a-f0-9]{64}$/);
  });
  test("a PDF handoff keeps its originating operation, not the child job identity", () => {
    const deliveryKey = invoiceDeliveryOperationKey(params);
    expect(
      invoiceDeliveryOperationKey({
        ...params,
        job: { ...params.job, id: "456", name: "send-invoice-email" },
        deliveryKey,
      }),
    ).toBe(deliveryKey);
  });
  test("tenant, invoice, send/reminder and legitimate new jobs have separate keys", () => {
    const key = invoiceDeliveryOperationKey(params);
    for (const changed of [
      { ...params, teamId: "team-b" },
      { ...params, invoiceId: "invoice-b" },
      { ...params, kind: "reminder" as const },
      { ...params, job: { ...params.job, id: "124" } },
      {
        ...params,
        job: { ...params.job, timestamp: params.job.timestamp + 1 },
      },
    ])
      expect(invoiceDeliveryOperationKey(changed)).not.toBe(key);
  });
  test("schedule regeneration deduplicates by the exact version and separates a new version", () => {
    const scheduled = {
      ...params,
      expectedScheduledJobId: "invoices:schedule-a",
    };
    const key = invoiceDeliveryOperationKey(scheduled);
    expect(
      invoiceDeliveryOperationKey({
        ...scheduled,
        job: { ...params.job, id: "different-generation" },
      }),
    ).toBe(key);
    expect(
      invoiceDeliveryOperationKey({
        ...scheduled,
        expectedScheduledJobId: "invoices:schedule-b",
      }),
    ).not.toBe(key);
  });
  test("missing timestamps/IDs and malformed inherited keys fail closed", () => {
    for (const job of [
      { ...params.job, id: undefined },
      { ...params.job, timestamp: Number.NaN },
      { ...params.job, timestamp: 0 },
    ])
      expect(() => invoiceDeliveryOperationKey({ ...params, job })).toThrow();
    for (const deliveryKey of ["", "short", "a".repeat(63), "g".repeat(64)])
      expect(() =>
        invoiceDeliveryOperationKey({ ...params, deliveryKey }),
      ).toThrow();
  });
});
