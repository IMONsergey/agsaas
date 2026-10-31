import Link from "next/link";

export function SunsetBanner() {
  return (
    <div className="w-full bg-secondary border-b border-border text-foreground">
      <div className="px-4 py-2 flex items-center justify-center gap-2 text-xs sm:text-sm font-sans text-center">
        <span>Midday is joining Ramp.</span>
        <Link
          href="https://midday.ai/updates/joining-ramp"
          className="underline underline-offset-2 hover:text-foreground/80 transition-colors"
        >
          Read the announcement
        </Link>
      </div>
    </div>
  );
}
