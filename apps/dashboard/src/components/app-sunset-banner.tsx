"use client";

import { Icons } from "@midday/ui/icons";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LocalStorageKeys } from "@/utils/constants";

export function AppSunsetBanner() {
  const [dismissed, setDismissed] = useLocalStorage(
    LocalStorageKeys.SunsetBannerDismissed,
    false,
  );
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || dismissed) {
    return null;
  }

  return (
    <div className="relative w-full bg-secondary border-b border-border text-foreground">
      <div className="px-4 py-2 pr-10 flex items-center justify-center gap-2 text-xs sm:text-sm font-sans text-center">
        <span>
          Midday is joining Ramp. Your account stays active while we wind down.
        </span>
        <Link
          href="https://midday.ai/updates/joining-ramp"
          className="underline underline-offset-2 hover:text-foreground/80 transition-colors"
        >
          Read the announcement
        </Link>
      </div>

      <button
        type="button"
        aria-label="Dismiss"
        data-track="Sunset Banner Dismissed"
        onClick={() => setDismissed(true)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 transition-colors"
      >
        <Icons.Close size={14} />
      </button>
    </div>
  );
}
