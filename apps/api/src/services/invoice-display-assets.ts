import { loadPublicLogo } from "@midday/invoice";

/** MCP HTML receives only bounded own Storage image bytes, never a persisted
 * remote URL or a database-provided data URI. Other invoice fields are unchanged.
 */
export async function embedInvoiceLogoForDisplay<
  T extends {
    template?: { logoUrl?: string | null } | null;
  },
>(invoice: T): Promise<T> {
  if (!invoice.template) return invoice;
  const logoUrl = await loadPublicLogo(invoice.template.logoUrl);
  return { ...invoice, template: { ...invoice.template, logoUrl } };
}
