import { notFound, redirect } from "next/navigation";
import { categories } from "@/data/apps";
export default async function Page({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  if (!categories.some((item) => item.id === category)) notFound();
  redirect("/integrations");
}
