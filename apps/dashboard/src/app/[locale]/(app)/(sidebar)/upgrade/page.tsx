import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Billing | AGSaaS" };

export default function UpgradePage() {
  redirect("/settings/billing");
}
