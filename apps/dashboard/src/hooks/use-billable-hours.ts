import { useQuery } from "@tanstack/react-query";
import { formatISO } from "date-fns";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";

type UseBillableHoursParams = {
  date: Date | string;
  view: "week" | "month";
  weekStartsOnMonday?: boolean;
  enabled?: boolean;
  refetchInterval?: number | false;
  refetchOnWindowFocus?: boolean;
};

/**
 * Single source of truth for billable hours calculations.
 * Reporting intervals are clipped on the backend in the user calendar timezone.
 */
export function useBillableHours(params: UseBillableHoursParams) {
  const {
    date,
    view,
    weekStartsOnMonday = false,
    enabled = true,
    refetchInterval,
    refetchOnWindowFocus,
  } = params;
  const trpc = useTRPC();
  const { data: user } = useUserQuery();

  // Convert date to ISO string format (YYYY-MM-DD)
  const dateString =
    typeof date === "string"
      ? date
      : formatISO(date, { representation: "date" });

  return useQuery({
    ...trpc.trackerEntries.getBillableHours.queryOptions({
      date: dateString,
      view,
      weekStartsOnMonday,
      timezone:
        user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    enabled,
    refetchInterval,
    refetchOnWindowFocus,
  });
}
