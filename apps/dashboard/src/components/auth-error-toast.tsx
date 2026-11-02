"use client";

import { useToast } from "@midday/ui/use-toast";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { getAuthCallbackErrorMessage } from "@/utils/auth-flow";

export function AuthErrorToast() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");
  const { toast } = useToast();
  const shownError = useRef<string | null>(null);

  useEffect(() => {
    const description = getAuthCallbackErrorMessage(error);
    if (!description || shownError.current === error) return;

    shownError.current = error;
    toast({ title: "Unable to sign in", description, variant: "error" });
  }, [error, toast]);

  return null;
}
