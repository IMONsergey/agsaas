import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountDeletionRecovery } from "@/components/account-deletion-recovery";
import { DeleteAccount } from "@/components/delete-account";
import { getQueryClient, HydrateClient, trpc } from "@/trpc/server";
import { getAccountEntryRedirect } from "@/utils/account-deletion";

export const metadata: Metadata = { title: "Account deletion | AGSaaS" };

export default async function AccountDeletionPage() {
  const queryClient = getQueryClient();
  // No team queries: deletion may already have removed every membership.
  const result = await queryClient.fetchQuery(trpc.user.me.queryOptions()).then(
    (user) => ({ status: "loaded" as const, user }),
    () => ({ status: "unavailable" as const }),
  );
  if (result.status === "loaded") {
    const destination = getAccountEntryRedirect(result.user);
    if (destination !== "/account-deletion") redirect(destination ?? "/");
  }

  return (
    <HydrateClient>
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-[480px]">
          <h1 className="sr-only">Account deletion</h1>
          {result.status === "loaded" ? (
            <DeleteAccount pendingDeletion />
          ) : (
            <AccountDeletionRecovery />
          )}
        </div>
      </main>
    </HydrateClient>
  );
}
