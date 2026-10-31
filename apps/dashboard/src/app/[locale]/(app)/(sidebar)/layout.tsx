import { redirect } from "next/navigation";
import { AppSunsetBanner } from "@/components/app-sunset-banner";
import { ExportStatus } from "@/components/export-status";
import { GlobalTimerProvider } from "@/components/global-timer-provider";
import { Header } from "@/components/header";
import { GlobalSheetsProvider } from "@/components/sheets/global-sheets-provider";
import { Sidebar } from "@/components/sidebar";
import { TimezoneDetector } from "@/components/timezone-detector";
import {
  batchPrefetch,
  getQueryClient,
  HydrateClient,
  trpc,
} from "@/trpc/server";
import { getAccountEntryRedirect } from "@/utils/account-deletion";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const queryClient = getQueryClient();

  // Fetch the user – .catch → redirect so a transient API failure
  // (timeout, 5xx, expired session, etc.) doesn't crash the entire
  // layout and blank the page.
  const user = await queryClient
    .fetchQuery(trpc.user.me.queryOptions())
    .catch(() => redirect("/login"));

  const accountRedirect = getAccountEntryRedirect(user);
  if (accountRedirect) redirect(accountRedirect);

  // Team-scoped prefetches must not run for a pending account deletion. Such a
  // user needs the independent retry page, not onboarding or team queries.
  batchPrefetch([
    trpc.team.current.queryOptions(),
    trpc.invoice.defaultSettings.queryOptions(),
    trpc.search.global.queryOptions({ searchTerm: "" }),
  ]);

  return (
    <HydrateClient>
      <div className="relative">
        <Sidebar />

        <div className="md:ml-[70px] pb-4">
          <AppSunsetBanner />
          <Header />
          <div className="px-4 md:px-8">{children}</div>
        </div>

        <ExportStatus />
        <GlobalSheetsProvider />
        <GlobalTimerProvider />
        <TimezoneDetector />
      </div>
    </HydrateClient>
  );
}
