import { notFound, redirect } from "next/navigation";
import { getAllCompetitorSlugs } from "@/data/competitors";

type Props = { params: Promise<{ slug: string }> };
export default async function Page({ params }: Props) {
  const { slug } = await params;
  if (!getAllCompetitorSlugs().includes(slug)) notFound();
  redirect("/compare");
}
