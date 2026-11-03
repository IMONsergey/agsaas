import { site } from "@/lib/site";

const documents = {
  introduction: {
    title: "Start with your own records",
    section: "Getting started",
    description:
      "Create a useful workspace without connecting external services.",
    content:
      "## Your first workspace\n\n1. Sign in with the account provided by your administrator.\n2. Check the workspace name and reporting currency in Settings.\n3. Add a customer, then create a draft invoice.\n4. Add a manual transaction or import a small CSV statement.\n5. Upload a supporting document and review an export.\n\n## Optional connections\n\nOpen Apps to see the capabilities configured for this installation. Banking, outbound email, online payments, AI and messaging integrations are optional. A disabled integration does not prevent manual record keeping.\n\nDo not enter real payment credentials into a sample or test environment.",
  },
  invoices: {
    title: "Create and review invoices",
    section: "Records",
    description:
      "Work from a draft through issue, delivery and payment status.",
    content:
      "## Prepare a draft\n\nOpen Invoices and choose Create new. Select a customer and check their billing details. Add line items, quantities, rates, tax, currency, issue date and due date.\n\n## Issue and deliver\n\nReview the preview before issuing the document. A PDF or customer link can be used independently of email. Outbound email and online payment require their own configured services.\n\n## Check the result\n\nUse the invoice record to confirm the current issue, delivery and payment state. A queued delivery is not evidence that a recipient received an email. If an operation fails or remains pending, keep its identifier when contacting support.\n\nDo not mark an invoice as paid unless the payment has been verified. Document requirements depend on your business and jurisdiction.",
  },
  transactions: {
    title: "Manage transactions",
    section: "Records",
    description: "Create, classify and review financial records.",
    content:
      "## Add a transaction\n\nOpen Transactions and choose Add transaction. Choose the account, currency, amount and date. Use the sign convention shown by the form for money in and money out.\n\n## Review records\n\nAdd categories and tags, attach receipts and review imported values. Check filters before editing or exporting a selection.\n\n## Bank sync\n\nBank connections are available only when a provider is configured. Check the connection state and latest successful sync before treating a report as current. Manual entry and CSV import remain available.",
  },
  "csv-import": {
    title: "Import a CSV statement",
    section: "Records",
    description:
      "Map columns and validate a small sample before importing a statement.",
    content:
      "## Before import\n\nExport a CSV from your bank or existing ledger. Keep the original file. Check its delimiter, decimal format, date format and currency.\n\n## Import\n\n1. Open Transactions and choose Import CSV.\n2. Select or create the destination account.\n3. Upload the file and map the required columns.\n4. Review the preview, including dates and signed amounts.\n5. Submit the import and check the resulting records.\n\nIf the job fails, inspect its result before retrying the same statement. Do not assume a failed browser request means no records were created.",
  },
  customers: {
    title: "Maintain customer records",
    section: "Records",
    description:
      "Keep contact and billing details connected to invoices and projects.",
    content:
      "Open Customers and choose Add customer. Enter the name, contact details and billing address, then check currency and tax information before issuing a document.\n\nAutomatic enrichment is optional. Suggested business details are not verified legal or tax advice; review them before saving or using them on an invoice.\n\nUse the customer's invoice and project history to review work. Metric labels distinguish billed amounts from money received.",
  },
  "time-tracking": {
    title: "Track time",
    section: "Records",
    description: "Use project timers and manual time entries.",
    content:
      "Create a project and assign the correct customer. Start a timer or enter a dated work session manually. Check the timezone, duration, rate and billable state.\n\nStop active timers before reviewing a period. Review rounding when turning tracked work into an invoice. Time totals and invoice amounts represent different quantities.\n\nOn a phone, wide tables scroll inside their table region so actions remain reachable.",
  },
  documents: {
    title: "Store supporting documents",
    section: "Records",
    description:
      "Upload originals, review metadata and connect files to records.",
    content:
      "Open Vault and upload a supported file. Review its name and metadata after upload. Attach supporting evidence to the relevant transaction or invoice.\n\nOriginal storage and automatic document extraction are separate capabilities. If an extraction provider is unavailable, a file can still be stored without promising extracted fields.\n\nUse the application's download controls. File URLs and exported archives can grant access to financial data; share them only with the intended recipients.",
  },
  receipts: {
    title: "Collect receipts in Inbox",
    section: "Records",
    description:
      "Upload receipts directly or use a configured email or messaging connection.",
    content:
      "## Direct upload\n\nOpen Inbox and upload a receipt. Review the file and suggested information before matching it to a transaction.\n\n## Email forwarding\n\nUse only the forwarding address displayed by this installation. If no address is shown, forwarding is not configured. Do not send AGSaaS documents to an address belonging to another product.\n\n## Connected inboxes\n\nGmail and Outlook Inbox integrations are separate from AI tools with the same brand names. Use the Inbox integration for receipt import. Review connection status, then disconnect it when access is no longer needed.",
  },
  reports: {
    title: "Interpret reports",
    section: "Review and export",
    description: "Check the period, currency and reporting basis.",
    content:
      "Open Reports and select the intended period and currency. Read the metric definition before comparing totals: issued revenue, paid amounts, net and gross amounts can differ.\n\nCheck the underlying records and connection freshness. An empty workspace is not evidence of zero business activity.\n\nWhen sharing a report, review the selected data, link expiry and access. Revoke a link if it is no longer needed. Treat live reports and fixed snapshots according to the label shown by the application.",
  },
  exports: {
    title: "Export and verify records",
    section: "Review and export",
    description: "Confirm archive completeness before handing off records.",
    content:
      "Select the intended records or workspace export and start the job. Wait for the final result. A pending, failed or partial export should not be treated as complete.\n\nDownload the archive and keep its manifest. Check the selected period, counts and any missing-file warnings. Verify important financial totals against the source records before handing them to an accountant.\n\nStore exported financial data securely. An export is a data handoff; operational backups and restore procedures are managed separately by the installation administrator.",
  },
  security: {
    title: "Account and access security",
    section: "Administration",
    description:
      "Manage sessions, multi-factor authentication and scoped access.",
    content:
      "Use a strong unique password and enable an authenticator in Account → Security. Complete verification before leaving the setup flow.\n\nKeep access tokens private. Create tokens with only the permissions required for a task, and revoke access when it is no longer needed.\n\nWorkspace membership, roles and token scopes apply to records and files. A missing permission is not resolved by using a direct file or API URL.\n\nPassword recovery depends on configured authentication email. If recovery is unavailable, contact the installation administrator through a known channel.",
  },
  integrations: {
    title: "Connect optional services",
    section: "Administration",
    description: "Distinguish product integrations from AI tools.",
    content:
      "Open Apps to check which services are configured. A disabled Install button means the installation is not ready for that service.\n\nGmail and Outlook Inbox connections import receipts. Stripe Payments handles customer invoice payments. AI tools are separate connections for assistant actions and have a different scope.\n\nUse the authorization flow opened by this workspace. Check the account and permissions before granting access. After connecting, confirm the displayed status. Disconnect from the workspace when access is no longer required.",
  },
  billing: {
    title: "Workspace billing",
    section: "Administration",
    description: "Check the billing options enabled by the operator.",
    content:
      "Open Settings → Billing. If subscriptions are not enabled, the workspace shows its self-hosted billing state and no purchase is offered.\n\nWorkspace subscriptions and customer invoice payments are separate systems. Paying for workspace access does not configure your business's payment account.\n\nPublic plans, taxes, refund terms and commercial signup require approved operator configuration.",
  },
  developer: {
    title: "API and MCP access",
    section: "Administration",
    description:
      "Use the endpoints and access controls of your own installation.",
    content:
      "Open Developer settings to manage scoped access. The API base URL for this installation is:\n\n`{{API_URL}}`\n\nOpenAPI description: [this installation's API]({{API_URL}}/openapi).\n\nThe remote MCP endpoint is:\n\n`{{API_URL}}/mcp`\n\nUse a client compatible with the deployed transport and authorization flow. Select the correct account and team during authorization. Do not reuse an upstream Midday account or endpoint for AGSaaS.",
  },
  support: {
    title: "Get help with an operation",
    section: "Administration",
    description: "Keep useful details without disclosing secrets.",
    content:
      "Open Account → Support or use the contact provided by your administrator.\n\nInclude the screen or operation, the time, the expected result, the visible error and the operation ID if one is shown. Avoid sending access tokens, passwords, complete bank statements or unrelated customer data.\n\nIf a payment or delivery has an uncertain result, verify its state before retrying. A visible success message must refer to a confirmed result, not merely a submitted request.",
  },
};
const aliases: Record<string, keyof typeof documents> = {
  "getting-started": "introduction",
  "connect-bank": "transactions",
  invoicing: "invoices",
  "assistant-mcp": "developer",
  api: "developer",
  vault: "documents",
  inbox: "receipts",
};
export function getAllDocSlugs() {
  return Object.keys(documents);
}
export function getDocBySlug(slug: string) {
  const key = Object.hasOwn(documents, slug)
    ? (slug as keyof typeof documents)
    : aliases[slug];
  if (!key) return null;
  const doc = documents[key];
  return {
    slug: key,
    metadata: {
      title: doc.title,
      description: doc.description,
      section: doc.section,
      order: Object.keys(documents).indexOf(key),
    },
    content: doc.content
      .replaceAll("{{API_URL}}", site.apiUrl)
      .replaceAll("{{DASHBOARD_URL}}", site.dashboardUrl),
  };
}
export function getDocsData() {
  return getAllDocSlugs().map((slug) => getDocBySlug(slug)!);
}
export const docsNavigation = [
  ...new Set(Object.values(documents).map((doc) => doc.section)),
].map((section, index) => ({
  title: section,
  slug: `section-${index}`,
  docs: getDocsData()
    .filter((doc) => doc.metadata.section === section)
    .map((doc) => ({
      slug: doc.slug,
      title: doc.metadata.title,
      description: doc.metadata.description,
      order: doc.metadata.order,
    })),
}));
