"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

export function useInstanceCapabilities() {
  const trpc = useTRPC();
  return useQuery(
    trpc.apps.capabilities.queryOptions(undefined, { staleTime: 60_000 }),
  );
}
