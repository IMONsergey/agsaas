import Link from "next/link";
import { site } from "@/lib/site";

const links = [
  { href: "/about", label: "About" },
  { href: "/docs", label: "Documentation" },
  { href: "/support", label: "Support" },
  { href: "/status", label: "Service status" },
  { href: "/terms", label: "Terms" },
  { href: "/policy", label: "Privacy" },
  { href: "/source", label: "Source and notices" },
];

export function Footer() {
  return (
    <footer className="border-t border-border mt-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-10 space-y-6">
        <div className="flex flex-col sm:flex-row gap-6 justify-between">
          <p className="text-lg font-medium">AGSaaS</p>
          <nav
            aria-label="Footer navigation"
            className="flex flex-wrap gap-x-6 gap-y-3"
          >
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <p className="text-sm text-muted-foreground max-w-2xl">
          {site.description} Optional connections depend on the services
          configured by your administrator.
        </p>
        <p className="text-xs text-muted-foreground">
          AGSaaS is independently operated software derived from Midday.
          Original copyright and license notices are available with the source.
        </p>
      </div>
    </footer>
  );
}
