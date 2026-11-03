"use client";

import { createClient } from "@midday/supabase/client";
import { Button } from "@midday/ui/button";
import { useToast } from "@midday/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTRPC } from "@/trpc/client";

type Approval = {
  id: string;
  toolName: "invoices_send" | "invoices_delete";
  expiresAt: string;
  status: string;
  preview: { invoiceId: string; invoiceNumber: string | null; recipient: string | null; bcc: string[]; replyTo?: string; customerName: string | null; amount: number; currency: string; status: string };
  result?: { outcome: "queued" | "deleted" | "stale" } | null;
};

async function requestApprovals(path = "", method = "GET") {
  const { data: { session } } = await createClient().auth.getSession();
  if (!session?.access_token) throw new Error("Sign in to review this action.");
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/chat/approvals${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { approvals?: Approval[]; approval?: Approval; error?: string };
  if (!response.ok) throw new Error(body.error ?? "Unable to review this action. Please try again.");
  return body;
}

function formatAmount(amount: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount); }
  catch { return `${amount} ${currency}`; }
}

/** Server-fetched proposals only: a model-supplied tool result cannot create a confirmation button. */
export function ChatActionApprovals({ isStreaming, messageCount }: { isStreaming: boolean; messageCount: number }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useQuery(trpc.user.me.queryOptions());
  const queryKey = ["chat-action-approvals", user?.id, user?.teamId];
  const proposals = useQuery({
    queryKey,
    queryFn: async () => (await requestApprovals()).approvals ?? [],
    enabled: Boolean(user?.id && user.teamId),
    retry: false,
    staleTime: 1000,
    refetchInterval: query => isStreaming || (query.state.data?.length ?? 0) > 0 ? 5000 : false,
    refetchIntervalInBackground: false,
  });
  const { refetch } = proposals;
  useEffect(() => { if (!isStreaming && messageCount > 0 && user?.teamId) void refetch(); }, [messageCount, isStreaming, user?.teamId, refetch]);
  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) => requestApprovals(`/${id}/${decision}`, "POST"),
    onSuccess: data => {
      const approval = data.approval;
      const title = approval?.status === "rejected" ? "Action canceled" : approval?.result?.outcome === "deleted" ? "Invoice deleted" : "Invoice delivery queued";
      toast({ title });
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: trpc.invoice.get.queryKey() });
    },
    onError: error => {
      toast({ variant: "destructive", title: "Action was not completed", description: error.message });
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  if (proposals.error) return <div role="alert" className="border p-4 my-4 text-sm"><p>Unable to load pending action confirmations.</p><Button variant="outline" size="sm" onClick={() => void refetch()} className="mt-2">Try again</Button></div>;
  if (!proposals.data?.length) return null;
  return <section aria-label="Actions awaiting your confirmation" className="space-y-3 my-6">
    {proposals.data.map(approval => {
      const { preview } = approval;
      const sending = approval.toolName === "invoices_send";
      const expired = Date.parse(approval.expiresAt) <= Date.now();
      return <article key={approval.id} className="rounded-lg border bg-background p-4 space-y-3">
        <h3 className="font-medium">{sending ? "Review invoice delivery" : "Review invoice deletion"}</h3>
        <p className="text-sm">{sending ? "Confirm the exact recipients and amount below to queue delivery." : "Confirm to permanently delete this invoice."}</p>
        <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 text-sm break-words">
          <dt className="text-muted-foreground">Invoice</dt><dd>{preview.invoiceNumber ?? preview.invoiceId}</dd>
          <dt className="text-muted-foreground">Customer</dt><dd>{preview.customerName ?? "—"}</dd>
          <dt className="text-muted-foreground">Amount</dt><dd>{formatAmount(preview.amount, preview.currency)} ({preview.currency})</dd>
          <dt className="text-muted-foreground">Status</dt><dd>{preview.status}</dd>
          {sending && <><dt className="text-muted-foreground">To</dt><dd>{preview.recipient}</dd><dt className="text-muted-foreground">BCC</dt><dd>{preview.bcc.length ? preview.bcc.join(", ") : "None"}</dd>{preview.replyTo && <><dt className="text-muted-foreground">Reply to</dt><dd>{preview.replyTo}</dd></>}</>}
          <dt className="text-muted-foreground">Expires</dt><dd>{new Date(approval.expiresAt).toLocaleTimeString()}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">Changes to the invoice or recipients require a new confirmation.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant={sending ? "default" : "destructive"} disabled={review.isPending || expired} onClick={() => review.mutate({ id: approval.id, decision: "approve" })}>{expired ? "Expired" : sending ? "Confirm and queue delivery" : "Confirm deletion"}</Button>
          <Button variant="outline" disabled={review.isPending} onClick={() => review.mutate({ id: approval.id, decision: "reject" })}>Cancel action</Button>
        </div>
      </article>;
    })}
  </section>;
}
