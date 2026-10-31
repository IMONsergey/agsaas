"use client";

import { LogEvents } from "@midday/events/events";
import { createClient } from "@midday/supabase/client";
import { Alert, AlertDescription } from "@midday/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@midday/ui/alert-dialog";
import { Button } from "@midday/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { Input } from "@midday/ui/input";
import { Label } from "@midday/ui/label";
import { useOpenPanel } from "@openpanel/nextjs";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useTRPC } from "@/trpc/client";
import {
  canStartAccountDeletion,
  getAccountDeletionErrorMessage,
  tryAccountDeletionSignOut,
} from "@/utils/account-deletion";

export function DeleteAccount({
  pendingDeletion = false,
}: {
  pendingDeletion?: boolean;
}) {
  const supabase = createClient();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { track } = useOpenPanel();
  const deleteUserMutation = useMutation(trpc.user.delete.mutationOptions());
  const [value, setValue] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletionConfirmed, setDeletionConfirmed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "deleting" | "signing-out">(
    "idle",
  );
  const inFlight = useRef(false);
  const isBusy = phase !== "idle";

  const leaveSession = async () => {
    const signedOut = await tryAccountDeletionSignOut((options) =>
      supabase.auth.signOut(options),
    );
    if (signedOut) {
      queryClient.clear();
      // A full navigation also drops cached team/profile UI after deletion.
      window.location.assign("/login");
    }
    return signedOut;
  };

  const handleDelete = async () => {
    if (
      !canStartAccountDeletion({
        pendingDeletion,
        confirmation: value,
        isBusy: inFlight.current,
        deletionConfirmed,
      })
    )
      return;
    inFlight.current = true;
    setPhase("deleting");
    setError(null);
    try {
      try {
        await deleteUserMutation.mutateAsync();
      } catch (failure) {
        setError(getAccountDeletionErrorMessage(failure, pendingDeletion));
        setDialogOpen(false);
        try {
          // Mark cached user.me stale, then let the refreshed server route read
          // the durable marker before loading onboarding or team resources.
          await queryClient.invalidateQueries({
            queryKey: trpc.user.me.queryKey(),
            refetchType: "none",
          });
        } finally {
          router.refresh();
        }
        return;
      }

      setDeletionConfirmed(true);
      setDialogOpen(false);
      // Optional analytics must never prevent session cleanup or recovery.
      try {
        track(LogEvents.AccountDeleted.name);
      } catch {
        /* optional telemetry */
      }
      setPhase("signing-out");
      if (!(await leaveSession())) {
        setError(
          "Account deletion was confirmed, but this session could not be cleared. Try signing out again or return to login.",
        );
      }
    } finally {
      inFlight.current = false;
      setPhase("idle");
    }
  };

  const handleSignOut = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("signing-out");
    setError(null);
    try {
      if (!(await leaveSession())) {
        setError(
          "Could not sign out. Try again, or use the login link to check your session. This does not confirm account deletion.",
        );
      }
    } finally {
      inFlight.current = false;
      setPhase("idle");
    }
  };

  return (
    <Card className="border-destructive">
      <CardHeader>
        <CardTitle>
          {deletionConfirmed
            ? "Account deleted"
            : pendingDeletion
              ? "Account deletion pending"
              : "Delete account"}
        </CardTitle>
        <CardDescription>
          {deletionConfirmed
            ? "Account deletion was confirmed. Return to login to finish this session."
            : pendingDeletion
              ? "Your deletion request is still pending. Retry deletion to finish, or sign out and sign in again to check its status. You do not need to create or join a company to finish deleting your account."
              : "Permanently delete your personal account and remove your team memberships. Shared team records may be retained for the remaining members. This action cannot be undone."}
        </CardDescription>
      </CardHeader>
      {error && (
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </CardContent>
      )}
      <CardFooter className="flex flex-wrap justify-between gap-3">
        {pendingDeletion || error || deletionConfirmed ? (
          <div className="flex flex-col gap-2">
            <Button variant="outline" onClick={handleSignOut} disabled={isBusy}>
              {phase === "signing-out"
                ? "Signing out..."
                : "Sign out and return to login"}
            </Button>
            <a href="/login" className="underline">
              Go to login
            </a>
          </div>
        ) : (
          <div />
        )}

        {pendingDeletion && !deletionConfirmed ? (
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isBusy}
          >
            {phase === "deleting" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              "Retry deletion"
            )}
          </Button>
        ) : (
          !deletionConfirmed && (
            <AlertDialog
              open={dialogOpen}
              onOpenChange={(open) => {
                if (!isBusy) setDialogOpen(open);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  className="hover:bg-destructive text-muted"
                  disabled={isBusy}
                >
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. Your personal account will be
                    deleted, but this does not erase all history shared with
                    other team members.
                  </AlertDialogDescription>
                </AlertDialogHeader>

                <div className="flex flex-col gap-2 mt-2">
                  <Label htmlFor="confirm-delete">
                    Type <span className="font-medium">DELETE</span> to confirm.
                  </Label>
                  <Input
                    id="confirm-delete"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    disabled={isBusy}
                  />
                </div>

                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isBusy}>
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(event) => {
                      event.preventDefault();
                      void handleDelete();
                    }}
                    disabled={
                      !canStartAccountDeletion({
                        pendingDeletion: false,
                        confirmation: value,
                        isBusy,
                      })
                    }
                  >
                    {isBusy ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      "Continue"
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )
        )}
      </CardFooter>
    </Card>
  );
}
