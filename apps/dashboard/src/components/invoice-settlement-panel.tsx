"use client";

import { getCurrencyMultiplier } from "@midday/invoice/currency";
import { Button } from "@midday/ui/button";
import { Input } from "@midday/ui/input";
import { Label } from "@midday/ui/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";
import { FormatAmount } from "./format-amount";

function toExactMinor(text: string, currency: string) {
  const multiplier = BigInt(getCurrencyMultiplier(currency));
  const places = multiplier.toString().length - 1;
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${Math.max(places, 1)}})?$`).test(text))
    throw new Error("Enter a positive amount in the invoice currency.");
  const [whole, fraction = ""] = text.split(".");
  if (
    fraction.length > places ||
    (["isk", "ugx"].includes(currency) && /[1-9]/.test(fraction))
  )
    throw new Error("This currency requires an exact whole-unit amount.");
  const value =
    BigInt(whole!) * multiplier + BigInt(fraction.padEnd(places, "0") || "0");
  if (value <= 0n || value > 9_007_199_254_740_991n)
    throw new Error("Enter an amount within the supported range.");
  return value.toString();
}

export function InvoiceSettlementPanel({ invoiceId }: { invoiceId: string }) {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const query = useQuery(
    trpc.invoicePayments.settlement.queryOptions({ invoiceId }),
  );
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<"payment" | "refund">("payment");
  const [amount, setAmount] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const record = useMutation(
    trpc.invoicePayments.recordSettlement.mutationOptions({
      onSuccess: async () => {
        setOperationId(crypto.randomUUID());
        setAmount("");
        setReason("");
        setConfirmed(false);
        setError(null);
        await Promise.all([
          cache.invalidateQueries({
            queryKey: trpc.invoicePayments.settlement.queryKey({ invoiceId }),
          }),
          cache.invalidateQueries({
            queryKey: trpc.invoice.getById.queryKey({ id: invoiceId }),
          }),
          cache.invalidateQueries({ queryKey: trpc.invoice.get.queryKey() }),
          cache.invalidateQueries({ queryKey: trpc.customers.get.queryKey() }),
        ]);
      },
      onError: (failure) => {
        setError(failure.message);
        void query.refetch();
      },
    }),
  );
  const verifyProvider = useMutation(
    trpc.invoicePayments.reconcileSettlement.mutationOptions({
      onSuccess: async () => {
        setError(null);
        await Promise.all([
          cache.invalidateQueries({
            queryKey: trpc.invoicePayments.settlement.queryKey({ invoiceId }),
          }),
          cache.invalidateQueries({
            queryKey: trpc.invoice.getById.queryKey({ id: invoiceId }),
          }),
          cache.invalidateQueries({ queryKey: trpc.invoice.get.queryKey() }),
          cache.invalidateQueries({ queryKey: trpc.customers.get.queryKey() }),
        ]);
      },
      onError: (failure) => {
        setError(failure.message);
        void query.refetch();
      },
    }),
  );
  if (query.isPending)
    return (
      <div className="mt-6 text-sm text-muted-foreground" role="status">
        Loading payment history...
      </div>
    );
  if (query.isError)
    return (
      <div className="mt-6 text-sm" role="alert">
        Payment history is unavailable.{" "}
        <Button variant="outline" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  const data = query.data;
  const projection = data.projection;
  const currency = projection?.currency ?? data.entries[0]?.currency ?? "usd";
  const display = (value: string) => (
    <FormatAmount
      amount={Number(value) / getCurrencyMultiplier(currency)}
      currency={currency.toUpperCase()}
    />
  );
  const manualPayments = data.entries.filter(
    (entry) => entry.kind === "payment" && entry.provider === "manual",
  );
  return (
    <section
      className="mt-6 border-t pt-5 space-y-3"
      aria-labelledby={`settlement-${invoiceId}`}
    >
      <h3 id={`settlement-${invoiceId}`} className="text-sm font-medium">
        Payments and refunds
      </h3>
      {data.reconciliationRequired ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm">
            {data.reason ??
              "Verify original evidence before changing settlement history."}
          </p>
          {data.canManage && data.providerVerificationAvailable && (
            <>
              <p className="text-xs text-muted-foreground">
                Check current payments and refunds with Stripe. Pending or
                unverified results keep further money operations blocked.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={verifyProvider.isPending}
                onClick={() => {
                  setError(null);
                  verifyProvider.mutate({
                    invoiceId,
                    apply: true,
                    verifyProvider: true,
                  });
                }}
              >
                {verifyProvider.isPending
                  ? "Verifying with Stripe..."
                  : "Verify with Stripe"}
              </Button>
            </>
          )}
        </div>
      ) : (
        projection && (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>Received, after refunds</dt>
            <dd className="text-right">
              {display(projection.netSettledMinor)}
            </dd>
            <dt>Outstanding balance</dt>
            <dd className="text-right">{display(projection.balanceMinor)}</dd>
            {projection.overpaymentMinor !== "0" && (
              <>
                <dt>Overpayment</dt>
                <dd className="text-right">
                  {display(projection.overpaymentMinor)}
                </dd>
              </>
            )}
          </dl>
        )
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {data.entries.length ? (
        <ol
          className="space-y-2 text-xs"
          aria-label="Confirmed payment history"
        >
          {data.entries.map((entry) => (
            <li key={entry.id} className="border-b pb-2">
              <div className="flex justify-between">
                <span>
                  {entry.kind === "payment"
                    ? "Payment"
                    : entry.kind === "refund"
                      ? "Refund"
                      : "Refund reversal"}{" "}
                  · {entry.provider}
                </span>
                <span>{display(entry.amountMinor)}</span>
              </div>
              <div className="text-muted-foreground break-words">
                {new Date(entry.occurredAt).toLocaleDateString()} ·{" "}
                {entry.reason}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          No confirmed payment entries.
        </p>
      )}
      {data.canManage && !data.reconciliationRequired && projection && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            try {
              record.mutate({
                invoiceId,
                operationId,
                kind,
                amountMinor: toExactMinor(amount, currency),
                currency,
                ...(kind === "refund" ? { paymentId } : {}),
                occurredAt: new Date(`${date}T12:00:00.000Z`).toISOString(),
                reason,
                confirmed: true,
              });
            } catch (failure) {
              setError(
                failure instanceof Error
                  ? failure.message
                  : "Check the payment details.",
              );
            }
          }}
        >
          <p className="text-xs text-muted-foreground">
            Record money already received or returned outside Stripe. This entry
            does not transfer funds. Stripe payments and refunds are confirmed
            automatically by the provider.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor={`kind-${invoiceId}`}>Entry</Label>
              <select
                className="h-9 w-full border bg-background px-2"
                id={`kind-${invoiceId}`}
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as "payment" | "refund")
                }
              >
                <option value="payment">Received payment</option>
                <option value="refund" disabled={!manualPayments.length}>
                  Confirmed refund
                </option>
              </select>
            </div>
            <div>
              <Label htmlFor={`amount-${invoiceId}`}>
                Amount ({currency.toUpperCase()})
              </Label>
              <Input
                id={`amount-${invoiceId}`}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                required
              />
            </div>
          </div>
          {kind === "refund" && (
            <div>
              <Label htmlFor={`payment-${invoiceId}`}>Original payment</Label>
              <select
                className="h-9 w-full border bg-background px-2"
                id={`payment-${invoiceId}`}
                required
                value={paymentId}
                onChange={(event) => setPaymentId(event.target.value)}
              >
                <option value="">Select a payment</option>
                {manualPayments.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {new Date(entry.occurredAt).toLocaleDateString()} ·{" "}
                    {entry.reason} ·{" "}
                    {Number(
                      projection.paymentBalances.find(
                        (item) => item.paymentId === entry.id,
                      )?.refundableMinor ?? "0",
                    ) / getCurrencyMultiplier(currency)}{" "}
                    {currency.toUpperCase()} refundable
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <Label htmlFor={`date-${invoiceId}`}>Confirmed date (UTC)</Label>
            <Input
              type="date"
              id={`date-${invoiceId}`}
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor={`reason-${invoiceId}`}>Reference or reason</Label>
            <Input
              id={`reason-${invoiceId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              required
            />
          </div>
          <label className="flex gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              required
            />
            <span>I verified that this money was received or returned.</span>
          </label>
          <Button type="submit" disabled={record.isPending || !confirmed}>
            {record.isPending ? "Recording..." : "Record confirmed entry"}
          </Button>
        </form>
      )}
    </section>
  );
}
