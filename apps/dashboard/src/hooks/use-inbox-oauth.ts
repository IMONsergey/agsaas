"use client";

import { useToast } from "@midday/ui/use-toast";
import { useMutation } from "@tanstack/react-query";
import { getInboxOAuthUrl } from "@/utils/inbox-oauth";

export function useInboxOAuth() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: getInboxOAuthUrl,
    onSuccess: (url) => {
      window.location.assign(url);
    },
    onError: () => {
      toast({
        variant: "error",
        title: "Unable to start email connection. Please try again.",
      });
    },
  });
}
