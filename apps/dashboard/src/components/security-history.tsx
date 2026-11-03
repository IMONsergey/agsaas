"use client";

import { Button } from "@midday/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { Input } from "@midday/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

const reasonText: Record<string, string> = {
  provider_console_required:
    "Remove this application's grant in the provider's security settings, then record the confirmation reference.",
  provider_partial_revocation:
    "The provider confirmed only part of the token revocation. Verify all remaining permissions in the provider's security settings.",
  provider_result_unknown:
    "The provider response was interrupted. Verify the grant before confirming completion.",
  grant_still_used:
    "Another workspace still uses this provider grant. Resolve that shared connection before revoking it.",
  provider_connection_reconciliation:
    "Verify this authorization attempt in the connector provider's console. An unknown attempt continues to occupy its connector slot.",
  billing_retention_review:
    "Verify subscription cancellation and the required billing retention before confirming.",
  backup_and_legacy_asset_review:
    "Verify backup retention, object versions, and any legacy assets outside the current storage namespaces before confirming.",
  configuration_unavailable:
    "The cleanup service needs its own provider configuration. The operation remains pending.",
};

export function SecurityHistory() {
  const trpc = useTRPC(),
    queryClient = useQueryClient();
  const [beforeId, setBeforeId] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState("");
  const audit = useQuery(
    trpc.securityAudit.list.queryOptions({ limit: 25, beforeId }),
  );
  const cleanups = useQuery({
    ...trpc.resourceCleanup.list.queryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some((row) =>
        ["pending", "processing"].includes(row.status),
      )
        ? 5000
        : false,
    refetchIntervalInBackground: false,
  });
  const attempts = useQuery(trpc.connectors.attempts.queryOptions());
  const acknowledge = useMutation(
    trpc.resourceCleanup.acknowledge.mutationOptions({
      onSuccess: async () => {
        setConfirmId(null);
        setEvidence("");
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.resourceCleanup.list.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.securityAudit.list.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.connectors.attempts.queryKey(),
          }),
        ]);
      },
    }),
  );
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Deletion and disconnection</CardTitle>
          <CardDescription>
            Local access ends when a request is accepted. Files, external
            permissions, billing and backup retention have separate confirmation
            states.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {cleanups.isError ? (
            <p role="status">
              Workspace owners can view cleanup status. Your account must remain
              signed in.
            </p>
          ) : cleanups.isPending ? (
            <p>Loading cleanup status…</p>
          ) : cleanups.data.length === 0 ? (
            <p>No cleanup requests.</p>
          ) : (
            cleanups.data.map((row) => (
              <div
                key={row.id}
                className="border rounded-md p-3 space-y-2 text-sm"
              >
                <div className="flex justify-between gap-2">
                  <strong>{row.provider || row.kind}</strong>
                  <span>{row.status.replaceAll("_", " ")}</span>
                </div>
                <p className="text-muted-foreground">
                  Requested {new Date(row.createdAt).toLocaleString()} ·
                  Reference {row.id}
                </p>
                {row.reason && (
                  <p>
                    {reasonText[row.reason] || row.reason.replaceAll("_", " ")}
                  </p>
                )}
                {["manual_required", "unknown", "failed"].includes(
                  row.status,
                ) &&
                  ["provider", "billing", "retention", "marketing"].includes(
                    row.kind,
                  ) &&
                  (confirmId === row.id ? (
                    <div className="space-y-2">
                      <p>
                        Confirm only after checking the external system. Use an
                        operational case or evidence ID; do not include personal
                        information.
                      </p>
                      <Input
                        aria-label="Cleanup confirmation reference"
                        placeholder="CASE-2026-001"
                        value={evidence}
                        maxLength={128}
                        onChange={(event) => setEvidence(event.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={
                            acknowledge.isPending ||
                            !/^[A-Z0-9][A-Z0-9._:-]{5,127}$/i.test(evidence)
                          }
                          onClick={() =>
                            acknowledge.mutate({
                              id: row.id,
                              evidenceReference: evidence,
                              confirmedExternally: true,
                            })
                          }
                        >
                          I verified completion externally
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEvidence("");
                        setConfirmId(row.id);
                      }}
                    >
                      Record external confirmation
                    </Button>
                  ))}
              </div>
            ))
          )}
          {acknowledge.error && <p role="alert">{acknowledge.error.message}</p>}
          {attempts.data?.some((row) => row.status !== "active") && (
            <div className="border rounded-md p-3 space-y-2 text-sm">
              <strong>Connector authorization attempts</strong>
              {attempts.data
                .filter((row) => row.status !== "active")
                .map((row) => (
                  <p key={row.id}>
                    {row.toolkit}: {row.status}. Reference {row.id}
                  </p>
                ))}
              <p>
                Pending and uncertain attempts keep their connector slot until
                their outcome is verified.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await queryClient.fetchQuery(
                    trpc.connectors.connections.queryOptions(),
                  );
                  await attempts.refetch();
                }}
              >
                Check provider connection status
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Security history</CardTitle>
          <CardDescription>
            {audit.data?.scope === "personal"
              ? "Your account security events. Workspace history is visible to its owners."
              : "Security changes are recorded together with the change. Credentials and personal message content are excluded."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {audit.isError ? (
            <p role="status">
              Security history could not be loaded. Try refreshing the page.
            </p>
          ) : audit.isPending ? (
            <p>Loading security history…</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="text-left p-2">Time</th>
                      <th className="text-left p-2">Action</th>
                      <th className="text-left p-2">Actor</th>
                      <th className="text-left p-2">Target / change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data.events.map((event) => (
                      <tr key={event.id} className="border-t">
                        <td className="p-2 whitespace-nowrap">
                          {new Date(event.createdAt).toLocaleString()}
                        </td>
                        <td className="p-2">{event.operation}</td>
                        <td className="p-2 break-all">
                          {event.actorUserId || "System"}
                        </td>
                        <td className="p-2 break-all">
                          {event.targetType}: {event.targetId}
                          <pre className="text-xs whitespace-pre-wrap">
                            {JSON.stringify(event.metadata)}
                          </pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {audit.data.events.length === 0 && <p>No security events yet.</p>}
              <div className="flex gap-2 mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!history.length}
                  onClick={() => {
                    setBeforeId(history.at(-1));
                    setHistory((values) => values.slice(0, -1));
                  }}
                >
                  Newer
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!audit.data.nextCursor}
                  onClick={() => {
                    setHistory((values) => [...values, beforeId]);
                    setBeforeId(audit.data.nextCursor ?? undefined);
                  }}
                >
                  Older
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
