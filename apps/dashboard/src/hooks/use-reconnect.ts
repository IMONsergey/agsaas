"use client";

import { useToast } from "@midday/ui/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAction } from "next-safe-action/hooks";
import { parseAsString, useQueryStates } from "nuqs";
import { useCallback, useEffect, useRef, useState } from "react";
import { manualSyncTransactionsAction } from "@/actions/transactions/manual-sync-transactions-action";
import { useTRPC } from "@/trpc/client";

type Status = "FAILED" | "SYNCING" | "COMPLETED" | null;
export function useReconnect({
  connectionId,
}: {
  connectionId: string;
  provider: string | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast, dismiss } = useToast();
  const [generation, setGeneration] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [params, setParams] = useQueryStates({
    step: parseAsString,
    id: parseAsString,
  });
  const hasTriggered = useRef(false);
  const request = useAction(manualSyncTransactionsAction, {
    onExecute: () => {
      setStatus("SYNCING");
      setGeneration(null);
    },
    onSuccess: ({ data }) => {
      if (data) setGeneration(data.generation);
      else setStatus("FAILED");
    },
    onError: () => {
      setStatus("FAILED");
      setGeneration(null);
      toast({
        variant: "error",
        title: "Bank synchronization could not be requested",
        duration: 5000,
      });
    },
  });
  const state = useQuery(
    trpc.bankSync.status.queryOptions(
      { connectionId },
      {
        enabled: generation !== null && status === "SYNCING",
        refetchInterval:
          generation !== null && status === "SYNCING" ? 3000 : false,
        retry: 1,
      },
    ),
  );
  useEffect(() => {
    if (generation === null || status !== "SYNCING") return;
    if (state.error) {
      setStatus("FAILED");
      return;
    }
    if (!state.data) return;
    if (state.data.reason) {
      setStatus("FAILED");
      toast({
        variant: "error",
        title:
          state.data.reason === "configuration_unavailable"
            ? "Bank synchronization needs provider configuration"
            : "Bank synchronization is pending",
        description:
          "Your request is saved. Check the connection before trying again.",
        duration: 6000,
      });
      return;
    }
    if (
      state.data.completedGeneration >= generation &&
      state.data.lastCompletedAt
    )
      setStatus("COMPLETED");
  }, [generation, status, state.data, state.error, toast]);
  useEffect(() => {
    if (status !== "COMPLETED" && status !== "FAILED") return;
    if (status === "COMPLETED") dismiss();
    setGeneration(null);
    void queryClient.invalidateQueries({
      queryKey: trpc.bankConnections.get.queryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.bankAccounts.get.queryKey(),
    });
    if (status === "COMPLETED") {
      void queryClient.invalidateQueries({
        queryKey: trpc.transactions.get.queryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.transactions.get.infiniteQueryKey(),
      });
    }
  }, [status, dismiss, queryClient, trpc]);
  const triggerManualSync = useCallback(
    () => request.execute({ connectionId }),
    [connectionId, request.execute],
  );
  // Consent validation is a separate server operation. This callback only
  // requests a read of credentials already verified and saved by that operation.
  const triggerReconnect = triggerManualSync;
  useEffect(() => {
    if (
      params.step === "reconnect" &&
      params.id === connectionId &&
      !hasTriggered.current
    ) {
      hasTriggered.current = true;
      triggerManualSync();
      void setParams({ step: null, id: null });
    }
  }, [params.step, params.id, connectionId, triggerManualSync, setParams]);
  return {
    isSyncing: status === "SYNCING",
    status,
    triggerReconnect,
    triggerManualSync,
  };
}
