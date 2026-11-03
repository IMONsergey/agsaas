"use client";

import { Icons } from "@midday/ui/icons";
import Link from "next/link";
import { useInboxUpload } from "@/hooks/use-inbox-upload";

const ACTIONS = [
  {
    label: "Create invoice",
    icon: Icons.Invoice,
    href: "/invoices?invoiceType=create",
  },
  {
    label: "Add transaction",
    icon: Icons.CreateTransaction,
    href: "/transactions?createTransaction=true",
  },
  {
    label: "Import CSV",
    icon: Icons.Import,
    href: "/transactions?step=import&hide=true",
  },
  {
    label: "Add customer",
    icon: Icons.Customers,
    href: "/customers?createCustomer=true",
  },
  { label: "Track time", icon: Icons.Tracker, href: "/tracker?create=true" },
] as const;

const buttonClassName =
  "inline-flex min-h-10 items-center gap-2 border border-border bg-background px-3 py-2 text-sm text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2";

/** Core workflows must be usable without an AI or banking provider. */
export function QuickActions() {
  const { openFilePicker } = useInboxUpload();
  return (
    <nav
      aria-label="Create workspace records"
      className="flex items-center justify-center gap-3 pt-2 pb-10 w-full flex-wrap"
    >
      {ACTIONS.map(({ label, icon: Icon, href }) => (
        <Link key={href} href={href} className={buttonClassName}>
          <Icon size={16} aria-hidden="true" />
          <span>{label}</span>
        </Link>
      ))}
      <button
        type="button"
        className={buttonClassName}
        onClick={openFilePicker}
      >
        <Icons.Inbox2 size={16} aria-hidden="true" />
        <span>Upload receipt</span>
      </button>
    </nav>
  );
}
