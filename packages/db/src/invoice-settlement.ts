export type SettlementKind = "payment" | "refund" | "refund_reversal";
export type SettlementEntry = {
  id: string;
  kind: SettlementKind;
  amountMinor: string;
  currency: string;
  paymentId: string | null;
  reversesId: string | null;
  occurredAt: string;
};

export function exactMinor(value: string): bigint {
  if (!/^[1-9][0-9]{0,15}$/.test(value))
    throw new Error("Amount must be positive exact minor units");
  const amount = BigInt(value);
  if (amount > 9_007_199_254_740_991n)
    throw new Error("Amount exceeds the supported exact range");
  return amount;
}

/** Integer-only conservation of funds. Presentation and rates never enter this calculation. */
export function calculateInvoiceSettlement(
  invoiceAmountMinor: string,
  currency: string,
  entries: readonly SettlementEntry[],
) {
  const invoice =
    invoiceAmountMinor === "0" ? 0n : exactMinor(invoiceAmountMinor);
  let settled = 0n;
  let refunds = 0n;
  let reversals = 0n;
  const payments = new Map<string, bigint>();
  const refunded = new Map<string, bigint>();
  const refundsById = new Map<string, SettlementEntry>();
  const reversedById = new Map<string, bigint>();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error("Duplicate settlement entry");
    ids.add(entry.id);
    if (entry.currency !== currency)
      throw new Error("Settlement currency mismatch");
    const amount = exactMinor(entry.amountMinor);
    if (!Number.isFinite(Date.parse(entry.occurredAt)))
      throw new Error("Invalid settlement time");
    if (entry.kind === "payment") {
      if (entry.paymentId || entry.reversesId)
        throw new Error("Payment cannot reference another entry");
      settled += amount;
      payments.set(entry.id, amount);
    } else if (entry.kind === "refund") {
      if (!entry.paymentId || entry.reversesId)
        throw new Error("Refund requires its original payment");
      refunds += amount;
      refunded.set(
        entry.paymentId,
        (refunded.get(entry.paymentId) ?? 0n) + amount,
      );
      refundsById.set(entry.id, entry);
    } else if (entry.kind === "refund_reversal") {
      if (!entry.paymentId || !entry.reversesId)
        throw new Error("Refund reversal requires its original refund");
      reversals += amount;
      reversedById.set(
        entry.reversesId,
        (reversedById.get(entry.reversesId) ?? 0n) + amount,
      );
      refunded.set(
        entry.paymentId,
        (refunded.get(entry.paymentId) ?? 0n) - amount,
      );
    } else throw new Error("Unsupported settlement entry");
  }
  for (const entry of entries.filter(
    (item) => item.kind === "refund_reversal",
  )) {
    const original = refundsById.get(entry.reversesId!);
    if (
      !original ||
      original.paymentId !== entry.paymentId ||
      (reversedById.get(original.id) ?? 0n) > exactMinor(original.amountMinor)
    )
      throw new Error(
        "Refund reversal exceeds or mismatches its original refund",
      );
  }
  for (const [id, amount] of refunded) {
    const payment = payments.get(id);
    if (payment === undefined || amount < 0n || amount > payment)
      throw new Error("Refund exceeds the remaining confirmed payment");
  }
  if (settled > 9_007_199_254_740_991n)
    throw new Error("Aggregate settlements exceed the exact supported range");
  const refundedMinor = refunds - reversals;
  const net = settled - refundedMinor;
  const balance = invoice > net ? invoice - net : 0n;
  const overpayment = net > invoice ? net - invoice : 0n;
  return {
    invoiceAmountMinor: invoice.toString(),
    settledMinor: settled.toString(),
    refundedMinor: refundedMinor.toString(),
    netSettledMinor: net.toString(),
    balanceMinor: balance.toString(),
    overpaymentMinor: overpayment.toString(),
    currency,
    status:
      net >= invoice
        ? ("paid" as const)
        : settled > 0n && net === 0n
          ? ("refunded" as const)
          : ("unpaid" as const),
    paymentBalances: [...payments]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([paymentId, amount]) => ({
        paymentId,
        settledMinor: amount.toString(),
        refundedMinor: (refunded.get(paymentId) ?? 0n).toString(),
        refundableMinor: (amount - (refunded.get(paymentId) ?? 0n)).toString(),
      })),
  };
}
