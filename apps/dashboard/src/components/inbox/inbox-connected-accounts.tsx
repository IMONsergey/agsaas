"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Avatar, AvatarFallback } from "@midday/ui/avatar";
import { Badge } from "@midday/ui/badge";
import { Button } from "@midday/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { Icons } from "@midday/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@midday/ui/tooltip";
import { useToast } from "@midday/ui/use-toast";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Suspense, useEffect, useState } from "react";
import { useInboxOAuth } from "@/hooks/use-inbox-oauth";
import { useInstanceCapabilities } from "@/hooks/use-instance-capabilities";
import { useJobStatus } from "@/hooks/use-job-status";
import { useTRPC } from "@/trpc/client";
import {
  inboxQueuedAttachmentCount,
  inboxSyncPhase,
} from "@/utils/inbox-sync-status";
import { ConnectEmailModal } from "./connect-email-modal";
import { ConnectGmail } from "./connect-gmail";
import { ConnectOutlook } from "./connect-outlook";
import { DeleteInboxAccount } from "./delete-inbox-account";
import { InboxAccountsListSkeleton } from "./inbox-connected-accounts-skeleton";
import { SyncInboxAccount } from "./sync-inbox-account";

type InboxAccount = NonNullable<RouterOutputs["inboxAccounts"]["get"]>[number];

function InboxAccountItem({ account }: { account: InboxAccount }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | undefined>();
  const [isSyncing, setSyncing] = useState(false);
  const { toast, dismiss } = useToast();
  const { data: capabilities } = useInstanceCapabilities();
  const canReconnect =
    capabilities?.integrations[account.provider]?.enabled === true;

  const {
    status: jobState,
    result,
    queryError,
    error,
  } = useJobStatus({
    jobId,
    refetchInterval: (query) =>
      ["completed", "failed", "unknown"].includes(
        query.state.data?.status ?? "",
      )
        ? false
        : 1000,
  });
  const status = inboxSyncPhase(jobId, jobState, Boolean(queryError || error));

  const syncInboxAccountMutation = useMutation(
    trpc.inboxAccounts.sync.mutationOptions({
      onMutate: () => {
        setJobId(undefined);
        setSyncing(true);
      },
      onSuccess: (data) => {
        if (data) {
          setJobId(data.id);
        }
      },
      onError: () => {
        setSyncing(false);
        setJobId(undefined);
        dismiss();

        toast({
          duration: 3500,
          variant: "error",
          title: "Something went wrong please try again.",
        });
      },
    }),
  );

  useEffect(() => {
    if (isSyncing) {
      toast({
        title: "Syncing...",
        description:
          "We're scanning for PDF attachments and receipts, please wait.",
        duration: Number.POSITIVE_INFINITY,
        variant: "spinner",
      });
    }
  }, [isSyncing]);

  useEffect(() => {
    if (status === "COMPLETED") {
      dismiss();
      setJobId(undefined);
      setSyncing(false);

      // Show success toast with attachment count
      const attachmentCount = inboxQueuedAttachmentCount(result);
      const description =
        attachmentCount === undefined
          ? "Scan completed. Refreshing your inbox."
          : attachmentCount > 0
            ? `${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"} queued for processing.`
            : "No new attachments were queued.";

      toast({
        title: "Email scan completed",
        description,
        variant: "success",
        duration: 3500,
      });

      queryClient.invalidateQueries({
        queryKey: trpc.inboxAccounts.get.queryKey(),
      });

      queryClient.invalidateQueries({
        queryKey: trpc.inbox.get.queryKey(),
      });
    }
  }, [status]);

  useEffect(() => {
    if (status === "FAILED") {
      dismiss();
      setSyncing(false);
      setJobId(undefined);

      queryClient.invalidateQueries({
        queryKey: trpc.inboxAccounts.get.queryKey(),
      });

      toast({
        duration: 3500,
        variant: "error",
        title: "Inbox sync failed, please try again.",
      });
    }
  }, [status]);

  const handleManualSync = () => {
    syncInboxAccountMutation.mutate({
      id: account.id,
      manualSync: true,
    });
  };

  const connectMutation = useInboxOAuth();

  const isDisconnected = account.status === "disconnected";

  return (
    <div className="flex items-center justify-between py-4">
      <div className="flex items-center space-x-4">
        <Avatar className="size-[34px]">
          <AvatarFallback className="bg-white border border-border">
            {account.provider === "outlook" ? (
              <Icons.Outlook className="size-5" />
            ) : (
              <Icons.Gmail className="size-5" />
            )}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-col">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-medium">{account.email}</span>
            {isDisconnected && (
              <TooltipProvider delayDuration={0}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="tag-rounded"
                      className="text-xs cursor-help"
                    >
                      Disconnected
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[300px] text-xs">
                    <p>
                      Account access has expired. Email providers typically
                      expire access tokens periodically as part of their
                      security practices. Simply reconnect to restore
                      functionality.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <span className="text-muted-foreground text-xs">
            {isSyncing ? (
              "Syncing..."
            ) : (
              <>
                Last accessed{" "}
                {formatDistanceToNow(new Date(account.lastAccessed))} ago
              </>
            )}
          </span>
        </div>
      </div>

      <div className="flex space-x-2 items-center">
        {isDisconnected ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canReconnect || connectMutation.isPending}
            title={
              canReconnect ? undefined : "Not configured for this installation"
            }
            onClick={() =>
              connectMutation.mutate({
                provider: account.provider as "gmail" | "outlook",
              })
            }
            className="text-xs"
          >
            Reconnect
          </Button>
        ) : (
          <SyncInboxAccount
            disabled={
              !canReconnect || isSyncing || syncInboxAccountMutation.isPending
            }
            disabledReason={
              !canReconnect
                ? "Email sync is not configured for this installation"
                : undefined
            }
            onClick={handleManualSync}
          />
        )}
        <DeleteInboxAccount accountId={account.id} />
      </div>
    </div>
  );
}

function InboxAccountsList() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.inboxAccounts.get.queryOptions());

  if (!data?.length) {
    return (
      <div className="px-6 py-8 pb-12 text-center flex flex-col items-center">
        <div className="w-full max-w-[300px] flex flex-col space-y-3">
          <ConnectGmail />
          <ConnectOutlook />
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 divide-y">
      {data.map((account) => (
        <InboxAccountItem key={account.id} account={account} />
      ))}
    </div>
  );
}

export function InboxConnectedAccounts() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.inboxAccounts.get.queryOptions());

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center space-x-2">
          <span>Email Connections</span>
        </CardTitle>
        <CardDescription>
          Manage your connected email accounts or connect a new one.
        </CardDescription>
      </CardHeader>

      <Suspense fallback={<InboxAccountsListSkeleton />}>
        <InboxAccountsList />
      </Suspense>

      {data?.length > 0 && (
        <CardFooter className="flex justify-between">
          <div />

          <ConnectEmailModal>
            <Button data-event="Connect email" data-channel="email">
              Connect email
            </Button>
          </ConnectEmailModal>
        </CardFooter>
      )}
    </Card>
  );
}
