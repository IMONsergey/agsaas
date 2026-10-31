import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Midday is joining Ramp",
};

export default function UpgradePage() {
  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-200px)] md:py-6 md:-ml-8">
      <div className="w-full max-w-[640px] p-8 text-center">
        <h1 className="font-serif text-2xl text-foreground mb-4">
          Midday is joining Ramp
        </h1>
        <p className="font-sans text-base text-muted-foreground leading-normal mb-2">
          We're winding Midday down. Your account stays fully active — no new
          charges, nothing to upgrade — and you can keep using everything as
          normal while you migrate or export your data.
        </p>
        <p className="font-sans text-base text-muted-foreground leading-normal mb-8">
          Read more about what's next on the{" "}
          <Link
            href="https://midday.ai/updates/joining-ramp"
            className="underline hover:text-foreground transition-colors"
          >
            announcement post
          </Link>
          .
        </p>

        <p className="text-xs text-muted-foreground mt-8">
          Questions?{" "}
          <Link href="/account/support" className="hover:underline">
            Contact support
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
