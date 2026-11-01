import { describe, expect, test } from "bun:test";
import {
  INVOICE_EMAIL_ENVELOPE_MAX_BYTES,
  invoiceEmailClockIsUnsafe,
  invoiceEmailEnvelopeHash,
  validateInvoiceEmailEnvelope,
} from "../queries/invoice-email-deliveries";

describe("immutable invoice email bytes", () => {
  test("replay clock checks fail closed for regression, invalid dates and inconsistent prior attempts", () => {
    const row = {
      createdAt: "2026-11-01T00:00:00Z",
      firstAttemptAt: "2026-11-01T00:01:00Z",
      updatedAt: "2026-11-01T00:02:00Z",
      nextAttemptAt: "2026-11-01T01:00:00Z",
      leaseExpiresAt: "2026-11-01T01:00:00Z",
    };
    expect(invoiceEmailClockIsUnsafe(row, "2026-11-01T00:03:00Z")).toBe(false);
    expect(invoiceEmailClockIsUnsafe(row, "2026-11-01T00:01:00Z")).toBe(true);
    expect(invoiceEmailClockIsUnsafe(row, "invalid")).toBe(true);
    for (const field of [
      "createdAt",
      "firstAttemptAt",
      "updatedAt",
      "nextAttemptAt",
      "leaseExpiresAt",
    ] as const) {
      expect(
        invoiceEmailClockIsUnsafe(
          { ...row, [field]: "infinity" },
          "2026-11-01T00:03:00Z",
        ),
      ).toBe(true);
    }
    expect(
      invoiceEmailClockIsUnsafe(
        { ...row, firstAttemptAt: "2026-10-31T23:59:00Z" },
        "2026-11-01T00:03:00Z",
      ),
    ).toBe(true);
    expect(
      invoiceEmailClockIsUnsafe(
        { ...row, updatedAt: row.createdAt },
        "2026-11-01T00:03:00Z",
      ),
    ).toBe(true);
    expect(
      invoiceEmailClockIsUnsafe(
        { ...row, firstAttemptAt: null, leaseExpiresAt: null },
        "2026-11-01T00:03:00Z",
      ),
    ).toBe(false);
  });
  test("exact UTF-8 bytes are fingerprinted, not mutable document fields", () => {
    const envelope = '{"html":"Счет №1","attachments":[{"content":"UERG"}]}';
    const hash = invoiceEmailEnvelopeHash(envelope);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateInvoiceEmailEnvelope(envelope, hash)).not.toThrow();
    expect(() => validateInvoiceEmailEnvelope(`${envelope} `, hash)).toThrow(
      "integrity",
    );
  });
  test("size limit counts encoded bytes, not JavaScript characters", () => {
    const tooLarge = "я".repeat(INVOICE_EMAIL_ENVELOPE_MAX_BYTES / 2 + 1);
    expect(tooLarge.length).toBeLessThan(INVOICE_EMAIL_ENVELOPE_MAX_BYTES);
    expect(() =>
      validateInvoiceEmailEnvelope(
        tooLarge,
        invoiceEmailEnvelopeHash(tooLarge),
      ),
    ).toThrow("integrity");
  });
});
