import Link from "next/link";

export function SunsetBanner() {
  return (
    <div className="fixed top-0 left-0 right-0 z-[60] w-full bg-secondary border-b border-border text-foreground">
      <div className="px-4 h-9 flex items-center justify-center gap-2 text-xs sm:text-sm font-sans text-center">
        <span>Midday is joining Ramp.</span>
        <Link
          href="/updates/joining-ramp"
          className="underline underline-offset-2 hover:text-foreground/80 transition-colors"
        >
          Read the announcement
        </Link>
      </div>
    </div>
  );
}
