import { notFound, redirect } from "next/navigation";
export default async function Page({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const { page } = await params;
  if (page !== "1") notFound();
  redirect("/updates");
}
