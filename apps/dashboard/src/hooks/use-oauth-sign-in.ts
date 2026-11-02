"use client";

import { isDesktopApp } from "@midday/desktop-client/platform";
import { createClient } from "@midday/supabase/client";
import { useToast } from "@midday/ui/use-toast";
import type { Provider } from "@supabase/supabase-js";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { runAuthRequest } from "@/utils/auth-flow";
import { getUrl } from "@/utils/environment";

export type OAuthProvider = "google" | "apple" | "github" | "azure";

type ProviderConfig = {
  name: string;
  icon: "Google" | "Apple" | "Github" | "Microsoft";
  scopes?: string;
  queryParams?: Record<string, string>;
  variant: "primary" | "secondary";
  supportsReturnTo: boolean;
};

const OAUTH_PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    name: "Google",
    icon: "Google",
    queryParams: { prompt: "select_account" },
    variant: "secondary",
    supportsReturnTo: true,
  },
  apple: {
    name: "Apple",
    icon: "Apple",
    variant: "secondary",
    supportsReturnTo: false,
  },
  github: {
    name: "Github",
    icon: "Github",
    variant: "secondary",
    supportsReturnTo: true,
  },
  azure: {
    name: "Microsoft",
    icon: "Microsoft",
    scopes: "email profile openid",
    variant: "secondary",
    supportsReturnTo: true,
  },
};

export function useOAuthSignIn(provider: OAuthProvider) {
  const [isLoading, setLoading] = useState(false);
  const pending = useRef(false);
  const { toast } = useToast();
  const supabase = createClient();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("return_to");
  const config = OAUTH_PROVIDERS[provider];

  const handleSignIn = async () => {
    if (pending.current) return;

    const redirectTo = new URL("/api/auth/callback", getUrl());
    redirectTo.searchParams.append("provider", provider);

    const isDesktop = isDesktopApp();

    if (isDesktop) {
      redirectTo.searchParams.append("client", "desktop");
    } else if (config.supportsReturnTo && returnTo) {
      redirectTo.searchParams.append("return_to", returnTo);
    }

    const queryParams = isDesktop
      ? { ...config.queryParams, client: "desktop" }
      : config.queryParams;

    await runAuthRequest({
      request: () =>
        supabase.auth.signInWithOAuth({
          provider: provider as Provider,
          options: {
            redirectTo: redirectTo.toString(),
            scopes: config.scopes,
            queryParams,
          },
        }),
      setPending: (value) => {
        pending.current = value;
        setLoading(value);
      },
      onError: () => {
        toast({
          title: "Unable to sign in",
          description:
            "Please try again or use another available sign-in method.",
          variant: "error",
        });
      },
    });
  };

  return { handleSignIn, isLoading, config };
}
