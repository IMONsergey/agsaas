import Link from "next/link";
import { workspaceUrl } from "@/lib/site";

const links = [
  { href: "/#features", label: "Features" },
  { href: "/docs", label: "Guide" },
  { href: "/integrations", label: "Integrations" },
  { href: "/pricing", label: "Plans" },
  { href: "/support", label: "Help" },
];

export function Header({
  hideMenuItems = false,
}: {
  transparent?: boolean;
  hideMenuItems?: boolean;
}) {
  return (
    <header className="border-b border-border bg-background">
      <nav
        aria-label="Main navigation"
        className="max-w-6xl mx-auto px-4 sm:px-8 py-5 flex items-center justify-between gap-4"
      >
        <Link
          href="/"
          aria-label="AGSaaS home"
          className="text-xl font-semibold tracking-tight"
        >
          AGSaaS<span className="text-muted-foreground">.</span>
        </Link>
        {!hideMenuItems && (
          <>
            <div className="hidden md:flex items-center gap-6">
              {links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  {link.label}
                </Link>
              ))}
            </div>
            <details className="md:hidden relative ml-auto">
              <summary className="cursor-pointer px-3 py-2 border border-border text-sm">
                Menu
              </summary>
              <div className="absolute right-0 top-full mt-2 z-50 w-52 border border-border bg-background p-3 shadow-lg">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="block p-3 text-sm"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </details>
          </>
        )}
        <a
          href={workspaceUrl("/login")}
          className="shrink-0 border border-foreground bg-foreground text-background px-4 py-2 text-sm"
        >
          Open workspace
        </a>
      </nav>
    </header>
  );
}
