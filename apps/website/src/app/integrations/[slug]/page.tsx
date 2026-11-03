import { notFound, redirect } from "next/navigation";
import { getAllSlugs } from "@/data/apps";
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!getAllSlugs().includes(slug)) notFound();
  redirect("/integrations");
}
