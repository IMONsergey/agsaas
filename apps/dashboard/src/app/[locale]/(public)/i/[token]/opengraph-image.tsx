import { loadPublicLogo, OgTemplate } from "@midday/invoice";
import { getQueryClient, trpc } from "@/trpc/server";
import { ownOgImageResponse } from "@/utils/own-og-image";

export const contentType = "image/png";

type Props = {
  params: Promise<{ token: string }>;
};

export default async function Image({ params }: Props) {
  const { token } = await params;
  const queryClient = getQueryClient();

  const invoice = await queryClient
    .fetchQuery(
      trpc.invoice.getInvoiceByToken.queryOptions({
        token,
      }),
    )
    .catch(() => null);

  if (!invoice) {
    return new Response("Not found", { status: 404 });
  }

  const logo = await loadPublicLogo(invoice.template.logoUrl);

  return ownOgImageResponse(<OgTemplate data={invoice} logoDataUrl={logo} />, {
    width: 1200,
    height: 630,
  });
}
