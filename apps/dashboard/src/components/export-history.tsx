"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@midday/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useFileUrl } from "@/hooks/use-file-url";
import { useUserQuery } from "@/hooks/use-user";
import { downloadFile } from "@/lib/download";
import { useTRPC } from "@/trpc/client";
import {
  confirmExportHistoryDownload,
  exportHistoryOutcomeLabel,
  type TeamExportHistoryEntry,
} from "@/utils/export-history";

type ScopeRef = { current: string | null };
type Cursor = { createdAt: string; id: string };

function ArchiveDownload({
  entry,
  teamId,
  scope,
  scopeRef,
}: {
  entry: TeamExportHistoryEntry;
  teamId: string;
  scope: string;
  scopeRef: ScopeRef;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { url } = useFileUrl(
    entry.archive
      ? {
          type: "download",
          filePath: entry.archive.path,
          filename: entry.archive.fileName,
        }
      : null,
  );
  if (!entry.archive) return null;

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={!url || checking}
        onClick={async () => {
          if (!url || inFlight.current || scopeRef.current !== scope) return;
          const userKey = trpc.user.me.queryKey();
          const teamKey = trpc.team.current.queryKey();
          const profile =
            queryClient.getQueryData<RouterOutputs["user"]["me"]>(userKey);
          // File capabilities are session-bound. Keep them private and compare
          // cache state after the await too, before React has necessarily rerendered.
          if (
            !profile ||
            profile.team?.id !== teamId ||
            profile.fileKey !== new URL(url).searchParams.get("fk")
          )
            return;
          const currentScope = () => {
            if (
              !active.current ||
              queryClient.getQueryState(userKey)?.status === "error" ||
              queryClient.getQueryState(teamKey)?.status === "error"
            )
              return null;
            const currentUser =
              queryClient.getQueryData<RouterOutputs["user"]["me"]>(userKey);
            const currentTeam =
              queryClient.getQueryData<RouterOutputs["team"]["current"]>(
                teamKey,
              );
            return currentUser?.id === profile.id &&
              currentUser.team?.id === teamId &&
              currentUser.fileKey === profile.fileKey &&
              currentTeam?.id === teamId
              ? scopeRef.current
              : null;
          };
          if (currentScope() !== scope) return;
          inFlight.current = true;
          setChecking(true);
          setError(null);
          try {
            const archive = await confirmExportHistoryDownload({
              entry,
              teamId,
              scope,
              currentScope,
              read: (id) =>
                queryClient.fetchQuery({
                  ...trpc.team.exportHistoryEntry.queryOptions({ id }),
                  staleTime: 0,
                }),
            });
            if (archive && currentScope() === scope)
              await downloadFile(url, archive.fileName);
          } catch {
            if (active.current && scopeRef.current === scope)
              setError(
                "Could not confirm this export. Refresh its history and try again.",
              );
          } finally {
            inFlight.current = false;
            if (active.current) setChecking(false);
          }
        }}
      >
        {checking
          ? "Checking archive..."
          : entry.outcome === "complete"
            ? "Download"
            : entry.outcome === "failed"
              ? "Download diagnostic archive"
              : "Download incomplete archive"}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="status">
          {error}
        </p>
      )}
    </div>
  );
}

function TeamHistory({
  teamId,
  scope,
  scopeRef,
}: {
  teamId: string;
  scope: string;
  scopeRef: ScopeRef;
}) {
  const trpc = useTRPC();
  const [pages, setPages] = useState<Cursor[]>([]);
  const history = useQuery({
    ...trpc.team.exportHistory.queryOptions({ limit: 5, cursor: pages.at(-1) }),
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  // A browser query client can retain a successful previous-team response while
  // the current team's refetch fails. Such data is never a usable history.
  const current =
    !history.isError && history.data?.teamId === teamId ? history.data : null;
  const refresh = () => {
    if (pages.length) setPages([]);
    else void history.refetch();
  };

  return (
    <section
      className="space-y-4 border-t px-6 py-4"
      aria-label="Team export history"
    >
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">Recent team exports</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={history.isFetching}
          onClick={refresh}
        >
          {history.isFetching ? "Refreshing..." : "Refresh"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        These are saved archive results. Exports appear after their data
        snapshot is saved. Files may have been removed from the Vault since
        then.
      </p>
      {history.isError ? (
        <p role="status" className="text-sm text-destructive">
          Export history is unavailable. Refresh to try again.
        </p>
      ) : !current ? (
        <p role="status" className="text-sm text-muted-foreground">
          {history.isPending || history.isFetching
            ? "Loading export history..."
            : "Could not confirm this team's export history. Refresh to try again."}
        </p>
      ) : current.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No saved team exports yet.
        </p>
      ) : (
        <ul className="divide-y">
          {current.items.map((entry) => (
            <li key={entry.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">
                    {exportHistoryOutcomeLabel[entry.outcome]}
                  </p>
                  <time
                    dateTime={entry.createdAt}
                    className="text-xs text-muted-foreground"
                  >
                    {new Date(entry.createdAt).toLocaleString()}
                  </time>
                </div>
                <ArchiveDownload
                  entry={entry}
                  teamId={teamId}
                  scope={scope}
                  scopeRef={scopeRef}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {entry.outcome === "unknown"
                  ? "The snapshot is saved, but no archive outcome has been recorded. This does not confirm a failed job."
                  : entry.outcome === "unverified"
                    ? "The saved receipt does not identify a verified archive. No download is available."
                    : entry.outcome === "complete"
                      ? `${entry.totalItems} data items in the recorded complete archive.`
                      : `${entry.totalItems} data items; ${entry.missingFiles} files missing or invalid. This archive is incomplete. Read manifest.json before using it.`}
              </p>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Export reference</summary>
                <p className="mt-1 break-all">Operation: {entry.operationId}</p>
                <p className="break-all">Snapshot: {entry.id}</p>
                {entry.archive && (
                  <p className="break-all">
                    Archive SHA-256: {entry.archive.sha256}
                  </p>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
      {current && (pages.length > 0 || current.nextCursor) && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!pages.length || history.isFetching}
            onClick={() => setPages((value) => value.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!current.nextCursor || history.isFetching}
            onClick={() => {
              const cursor = current.nextCursor;
              if (cursor) setPages((value) => [...value, cursor]);
            }}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  );
}

export function ExportHistory() {
  const trpc = useTRPC();
  const user = useUserQuery();
  const team = useQuery(trpc.team.current.queryOptions());
  const scopeRef = useRef<string | null>(null);
  const teamId = user.data?.team?.id;
  const scope =
    !user.isError &&
    !team.isError &&
    user.data?.id &&
    teamId &&
    team.data?.id === teamId
      ? `${user.data.id}:${teamId}`
      : null;
  scopeRef.current = scope;
  useEffect(() => {
    scopeRef.current = scope;
    return () => {
      scopeRef.current = null;
    };
  }, [scope]);

  if (!scope || !teamId)
    return (
      <section
        className="space-y-2 border-t px-6 py-4"
        aria-label="Team export history"
      >
        <h3 className="text-sm font-medium">Recent team exports</h3>
        <p role="status" className="text-sm text-muted-foreground">
          {user.isPending || team.isPending
            ? "Loading your team..."
            : "Could not confirm your current team."}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={user.isFetching || team.isFetching}
          onClick={() => {
            void Promise.all([user.refetch(), team.refetch()]);
          }}
        >
          Refresh
        </Button>
      </section>
    );
  // Reset pagination and in-flight component state when account/team changes.
  return (
    <TeamHistory
      key={scope}
      teamId={teamId}
      scope={scope}
      scopeRef={scopeRef}
    />
  );
}
