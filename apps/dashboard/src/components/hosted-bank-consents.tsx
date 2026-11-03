"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@midday/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useInstanceCapabilities } from "@/hooks/use-instance-capabilities";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC, useTRPCClient } from "@/trpc/client";
import {
  type HostedConsentCommand,
  hostedBankConsentError,
  hostedBankConsentPresentation,
  hostedBankNavigationUrl,
  pendingHostedConsentCommand,
} from "@/utils/hosted-bank-consent";

type Consent = RouterOutputs["bankConsents"]["get"];
type Props = {
  enabled?: boolean;
  allowStart?: boolean;
  showUnavailable?: boolean;
  defaultCountryCode?: string;
  onVerified?: () => void;
};

/** Public configuration is only a display hint. The owner endpoint and each
 * subsequent SQL operation independently verify the current actor/session. */
export function HostedBankConsents({ enabled = true, ...props }: Props) {
  const { data: user } = useUserQuery();
  const { data: capabilities } = useInstanceCapabilities();
  if (!enabled) return null;
  if (!user?.id || !user.teamId) {
    return props.showUnavailable ? (
      <p className="text-sm text-muted-foreground" role="status">
        Loading bank connection availability...
      </p>
    ) : null;
  }
  return (
    <HostedBankConsentPanel
      key={`${user.id}:${user.teamId}`}
      {...props}
      userId={user.id}
      teamId={user.teamId}
      publiclyConfigured={capabilities?.hostedBanking.enabled === true}
    />
  );
}

function HostedBankConsentPanel({
  userId,
  teamId,
  publiclyConfigured,
  allowStart = true,
  showUnavailable = false,
  defaultCountryCode,
  onVerified,
}: Omit<Props, "enabled"> & {
  userId: string;
  teamId: string;
  publiclyConfigured: boolean;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const instanceId = useId();
  const scopeKey = ["hostedBankConsents", userId, teamId, instanceId] as const;
  const listKey = [...scopeKey, "list"] as const;
  const storageKey = `agsaas.bank-consent-command.v1:${userId}:${teamId}`;
  const mounted = useRef(false);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [country, setCountry] = useState<"US" | "CA">(
    defaultCountryCode?.toUpperCase() === "CA" ? "CA" : "US",
  );
  const [pendingCommand, setPendingCommand] =
    useState<HostedConsentCommand | null>(null);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    mounted.current = true;
    try {
      const pending = pendingHostedConsentCommand(
        sessionStorage.getItem(storageKey),
      );
      setPendingCommand(pending);
      if (pending) setCountry(pending.country);
      setStorageReady(true);
    } catch {
      setStorageReady(false);
    }
    return () => {
      mounted.current = false;
    };
  }, [storageKey]);

  const owner = useQuery({
    queryKey: [...scopeKey, "capability"],
    queryFn: ({ signal }) =>
      client.bankConsents.capability.query(undefined, { signal }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  const list = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) =>
      client.bankConsents.list.query(undefined, { signal }),
    enabled: owner.isSuccess,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    // Only our retained status is polled. Provider verification is an explicit action.
    refetchInterval: (state) =>
      state.state.data?.some(
        (row) => !hostedBankConsentPresentation(row).terminal,
      )
        ? 15_000
        : false,
  });
  const canConnect = owner.isSuccess && owner.data.enabled;
  const canAct =
    owner.isSuccess && list.isSuccess && !owner.isFetching && !list.isFetching;
  const rows = list.data ?? [];
  const unresolved = rows.filter(
    (row) => !hostedBankConsentPresentation(row).terminal,
  );
  const visibleRows = unresolved.length ? unresolved : rows.slice(0, 3);

  function refresh() {
    // UI refresh failures cannot turn a committed operation into a failed one.
    void Promise.allSettled([
      owner.refetch(),
      queryClient.invalidateQueries({
        queryKey: ["hostedBankConsents", userId, teamId],
      }),
    ]);
  }

  function saveReceipt(row: Consent) {
    if (!mounted.current) return;
    queryClient.setQueryData<Consent[]>(listKey, (current) =>
      [row, ...(current ?? []).filter((entry) => entry.id !== row.id)].slice(
        0,
        10,
      ),
    );
    if (hostedBankConsentPresentation(row).accepted) {
      void Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: trpc.bankConnections.get.queryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.bankAccounts.get.queryKey(),
        }),
      ]);
    }
  }

  async function run(work: () => Promise<void>) {
    if (operation.current || !mounted.current) return;
    operation.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      if (mounted.current) setMessage(hostedBankConsentError(error));
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        refresh();
      }
    }
  }

  async function start() {
    if (!canConnect || !canAct || !storageReady) return;
    await run(async () => {
      // Persist before sending. A lost response/remount recovers the same command;
      // the server's existing-intent path never repeats provider creation.
      const command = pendingHostedConsentCommand(
        sessionStorage.getItem(storageKey),
      ) ??
        pendingCommand ?? { requestId: crypto.randomUUID(), country };
      sessionStorage.setItem(storageKey, JSON.stringify(command));
      setPendingCommand(command);
      setCountry(command.country);
      const row = await client.bankConsents.start.mutate(command);
      if (!mounted.current) return;
      saveReceipt(row);
      try {
        const stored = pendingHostedConsentCommand(
          sessionStorage.getItem(storageKey),
        );
        if (stored?.requestId === command.requestId)
          sessionStorage.removeItem(storageKey);
        setPendingCommand(null);
      } catch {
        // The server receipt remains authoritative if browser persistence fails.
      }
      setMessage(hostedBankConsentPresentation(row).description);
    });
  }

  async function open(row: Consent) {
    if (!canConnect || !canAct) return;
    await run(async () => {
      // Never open a cached capability URL or a URL from browser callback inputs.
      const availability = await client.bankConsents.capability.query();
      if (!mounted.current) return;
      if (!availability.enabled) {
        setMessage(
          "Bank consent is currently unavailable. Your request remains saved.",
        );
        return;
      }
      const current = await client.bankConsents.get.query({ id: row.id });
      if (!mounted.current) return;
      saveReceipt(current);
      const url =
        current.status === "awaiting_consent"
          ? hostedBankNavigationUrl(current.url)
          : null;
      if (!url) {
        setMessage(
          "This consent link is no longer available. Review the current request status.",
        );
        return;
      }
      window.location.assign(url);
    });
  }

  async function verify(row: Consent) {
    if (!canConnect || !canAct) return;
    await run(async () => {
      const current = await client.bankConsents.complete.mutate({ id: row.id });
      if (!mounted.current) return;
      saveReceipt(current);
      if (hostedBankConsentPresentation(current).accepted) onVerified?.();
    });
  }

  async function cancel(row: Consent) {
    if (!canAct) return;
    await run(async () => {
      const current = await client.bankConsents.cancel.mutate({ id: row.id });
      saveReceipt(current);
    });
  }

  if (owner.isError) {
    if (!publiclyConfigured && !showUnavailable) return null;
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {hostedBankConsentError(owner.error)}
      </p>
    );
  }
  if (owner.isPending || (owner.isSuccess && list.isPending)) {
    if (!publiclyConfigured && !showUnavailable) return null;
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Checking bank connection availability...
      </p>
    );
  }
  if (!canConnect && !rows.length && !showUnavailable) return null;
  if (!allowStart && !rows.length && !list.isError) return null;

  return (
    <section
      className="space-y-4 py-4"
      aria-labelledby={`${instanceId}-title`}
      aria-busy={busy}
    >
      <div className="space-y-2">
        <h3 id={`${instanceId}-title`} className="text-sm font-medium">
          Bank consent with Plaid
        </h3>
        <p className="text-sm text-muted-foreground">
          {canConnect
            ? owner.data.environment === "sandbox"
              ? "Sandbox is enabled. These connections use test bank data."
              : "Connect a bank in the United States or Canada. Your team owner verifies the connection after consent."
            : "New bank consent is unavailable for this installation. You can still review or cancel saved requests."}
        </p>
      </div>

      {list.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {hostedBankConsentError(list.error)}
        </p>
      ) : (
        <>
          {!!visibleRows.length && (
            <ul className="space-y-3" aria-live="polite">
              {visibleRows.map((row) => {
                const state = hostedBankConsentPresentation(row);
                return (
                  <li key={row.id} className="border p-3 space-y-2">
                    <p className="text-sm font-medium">{state.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {state.description}
                    </p>
                    {state.needsReview && (
                      <p className="text-xs break-all">
                        Request reference: {row.id}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {state.canOpen && canConnect && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || !canAct}
                          onClick={() => void open(row)}
                        >
                          Continue at Plaid
                        </Button>
                      )}
                      {state.canVerify && canConnect && (
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy || !canAct}
                          onClick={() => void verify(row)}
                        >
                          Verify connection
                        </Button>
                      )}
                      {state.canCancel && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || !canAct}
                          onClick={() => void cancel(row)}
                        >
                          Cancel request
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {allowStart && canConnect && (
            <div className="space-y-3">
              {pendingCommand ? (
                <p className="text-xs text-muted-foreground">
                  A previous request did not receive a confirmed response.
                  Recover that request before starting another.
                </p>
              ) : unresolved.length ? (
                <p className="text-xs text-muted-foreground">
                  Finish or resolve your pending bank request before starting
                  another.
                </p>
              ) : (
                <div className="space-y-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`${instanceId}-country`}
                  >
                    Bank country
                  </label>
                  <select
                    id={`${instanceId}-country`}
                    className="flex h-9 w-full border border-input bg-background px-3 text-sm"
                    value={country}
                    disabled={busy || !canAct}
                    onChange={(event) => {
                      if (
                        event.target.value === "US" ||
                        event.target.value === "CA"
                      )
                        setCountry(event.target.value);
                    }}
                  >
                    <option value="US">United States</option>
                    <option value="CA">Canada</option>
                  </select>
                </div>
              )}
              {!storageReady && (
                <p className="text-xs text-muted-foreground">
                  Preparing a new connection is unavailable in this browser
                  session. Saved requests can still be managed.
                </p>
              )}
              <Button
                type="button"
                disabled={
                  busy ||
                  !canAct ||
                  !storageReady ||
                  (!pendingCommand && unresolved.length > 0)
                }
                onClick={() => void start()}
              >
                {pendingCommand
                  ? "Recover pending request"
                  : "Start bank connection"}
              </Button>
            </div>
          )}
        </>
      )}

      {message && (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy || owner.isFetching || list.isFetching}
        onClick={refresh}
      >
        Refresh status
      </Button>
      <p className="text-xs text-muted-foreground">
        Requests are shown only to the owner who started them in the same
        sign-in session. Returning from Plaid does not confirm a connection.
      </p>
    </section>
  );
}
