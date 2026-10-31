"use client";

import { createClient } from "@midday/supabase/client";
import { Alert, AlertDescription } from "@midday/ui/alert";
import { Button } from "@midday/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { tryAccountDeletionSignOut } from "@/utils/account-deletion";

/** A failed status read must not expose an unconfirmed destructive retry. */
export function AccountDeletionRecovery() {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const [isSigningOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOutInFlight = useRef(false);

  const leave = async () => {
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSigningOut(true);
    setError(null);
    try {
      const signedOut = await tryAccountDeletionSignOut((options) =>
        createClient().auth.signOut(options),
      );
      if (signedOut) {
        window.location.assign("/login");
      } else {
        setError(
          "Could not sign out. Try again, or use the login link below to check your session.",
        );
      }
    } finally {
      signOutInFlight.current = false;
      setSigningOut(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unable to check account deletion</CardTitle>
        <CardDescription>
          Your account status could not be loaded. This does not confirm that
          deletion succeeded or failed. Check again, or sign out and return to
          login. You do not need to create a new company to retry deletion.
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
        <Button
          variant="outline"
          disabled={isRefreshing || isSigningOut}
          onClick={() => startRefresh(() => router.refresh())}
        >
          {isRefreshing ? "Checking..." : "Check again"}
        </Button>
        <Button
          variant="outline"
          disabled={isSigningOut || isRefreshing}
          onClick={leave}
        >
          {isSigningOut ? "Signing out..." : "Sign out and return to login"}
        </Button>
        <a href="/login" className="underline">
          Go to login
        </a>
      </CardFooter>
    </Card>
  );
}
