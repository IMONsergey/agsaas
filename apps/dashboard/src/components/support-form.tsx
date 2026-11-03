"use client";
import { Button } from "@midday/ui/button";
import { Input } from "@midday/ui/input";
import { Textarea } from "@midday/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod/v3";
import { useTRPC } from "@/trpc/client";

const schema = z.object({
  requestId: z.string().uuid(),
  subject: z.string().trim().min(1).max(200),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  type: z.enum([
    "Transactions",
    "Vault",
    "Inbox",
    "Invoicing",
    "Tracker",
    "AI",
    "General",
  ]),
  message: z.string().trim().min(1).max(10000),
});
export function SupportForm() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const requestId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const history = useQuery(trpc.support.mine.queryOptions());
  const submit = useMutation(
    trpc.support.submit.mutationOptions({
      onSuccess: (result) => {
        if (!result.accepted) return;
        setReceipt(result.id);
        setError(null);
        formRef.current?.reset();
        requestId.current = null;
        void queryClient.invalidateQueries({
          queryKey: trpc.support.mine.queryKey(),
        });
      },
      onError: (failure) =>
        setError(
          failure.message ||
            "Receipt could not be confirmed. Your text is preserved; retry.",
        ),
    }),
  );
  return (
    <div className="space-y-8 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Send a request to the operator of this AGSaaS installation. Do not
        include passwords, access tokens, or full payment card details.
      </p>
      {receipt && (
        <p role="status" className="border p-4 text-sm break-all">
          Request received. Reference: {receipt}. Receipt confirms storage in
          the support queue; the operator will review it.
        </p>
      )}
      <form
        ref={formRef}
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          const data = new FormData(event.currentTarget);
          requestId.current ??= crypto.randomUUID();
          const parsed = schema.safeParse({
            requestId: requestId.current,
            subject: data.get("subject"),
            priority: data.get("priority"),
            type: data.get("type"),
            message: data.get("message"),
          });
          if (!parsed.success) {
            setError("Complete all fields and check their lengths.");
            return;
          }
          submit.mutate(parsed.data);
        }}
      >
        <div>
          <label htmlFor="support-subject" className="block text-sm mb-2">
            Subject
          </label>
          <Input
            id="support-subject"
            name="subject"
            required
            maxLength={200}
            disabled={submit.isPending}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="support-product" className="block text-sm mb-2">
              Product
            </label>
            <select
              id="support-product"
              name="type"
              defaultValue="General"
              className="w-full border bg-background p-2"
              disabled={submit.isPending}
            >
              {[
                "General",
                "Transactions",
                "Vault",
                "Inbox",
                "Invoicing",
                "Tracker",
                "AI",
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="support-priority" className="block text-sm mb-2">
              Severity
            </label>
            <select
              id="support-priority"
              name="priority"
              defaultValue="normal"
              className="w-full border bg-background p-2"
              disabled={submit.isPending}
            >
              {["low", "normal", "high", "urgent"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="support-message" className="block text-sm mb-2">
            Message
          </label>
          <Textarea
            id="support-message"
            name="message"
            required
            maxLength={10000}
            className="min-h-40"
            disabled={submit.isPending}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={submit.isPending}>
          {submit.isPending ? "Saving request…" : "Submit request"}
        </Button>
      </form>
      <section aria-labelledby="support-history-title">
        <h2 id="support-history-title" className="font-medium mb-3">
          Your recent requests
        </h2>
        {history.isPending && <p role="status">Loading requests…</p>}
        {history.isError && (
          <p role="alert">
            Requests could not be loaded.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void history.refetch()}
            >
              Retry
            </button>
          </p>
        )}
        {history.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No requests received from your account in this workspace.
          </p>
        )}
        <ul className="space-y-3">
          {history.data?.map((item) => (
            <li key={item.id} className="border p-3 text-sm break-words">
              <p className="font-medium">{item.subject}</p>
              <p>
                {item.status.replaceAll("_", " ")} ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground break-all">
                {item.id}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
