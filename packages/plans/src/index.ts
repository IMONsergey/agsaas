export type PlanKey = "starter" | "pro";
export type PlanProductKey =
  | "starter"
  | "starter_yearly"
  | "pro"
  | "pro_yearly";
export type PlanEnvironment = "production" | "sandbox";

/** Product IDs belong to this installation's billing account. */
export const getPlans = () =>
  ({
    starter: {
      id: process.env.POLAR_STARTER_PRODUCT_ID || "",
      name: "Starter",
      key: "starter",
      interval: "month",
    },
    starter_yearly: {
      id: process.env.POLAR_STARTER_YEARLY_PRODUCT_ID || "",
      name: "Starter Yearly",
      key: "starter",
      interval: "year",
    },
    pro: {
      id: process.env.POLAR_PRO_PRODUCT_ID || "",
      name: "Pro",
      key: "pro",
      interval: "month",
    },
    pro_yearly: {
      id: process.env.POLAR_PRO_YEARLY_PRODUCT_ID || "",
      name: "Pro Yearly",
      key: "pro",
      interval: "year",
    },
  }) as const;

export function getPlanProductId(plan: PlanKey, yearly: boolean): string {
  const productKey: PlanProductKey = yearly ? `${plan}_yearly` : plan;
  const id = getPlans()[productKey].id;
  if (!id) throw new Error("This subscription product is not configured");
  return id;
}

export function getPlanByProductId(productId: string): PlanKey {
  const plans = getPlans();
  const plan = Object.values(plans).find((p) => !!p.id && p.id === productId);

  if (!plan) {
    throw new Error("Plan not found");
  }

  return plan.key as PlanKey;
}

export function getPlanIntervalByProductId(
  productId: string,
): "month" | "year" {
  const plans = getPlans();
  const plan = Object.values(plans).find((p) => !!p.id && p.id === productId);

  if (!plan) {
    throw new Error("Plan not found");
  }

  return plan.interval;
}

export function getPlanName(plan: string | null | undefined): string {
  switch (plan) {
    case "starter":
      return "Starter";
    case "pro":
      return "Pro";
    case "trial":
      return "Trial";
    default:
      return "Free";
  }
}

export type PlanLimits = {
  users: number;
  bankConnections: number;
  connectors: number;
  storage: number;
  inbox: number;
  invoices: number;
};

export type PlanPricing = {
  starter: { monthly: number; yearly: number };
  pro: { monthly: number; yearly: number };
  currency: string;
  symbol: string;
};

export function getPlanPricing(continent?: string | null): PlanPricing {
  const isEUR = continent === "EU";
  return {
    starter: { monthly: 19, yearly: 15 },
    pro: { monthly: 49, yearly: 39 },
    currency: isEUR ? "EUR" : "USD",
    symbol: isEUR ? "€" : "$",
  };
}

export type PlanFeature = {
  label: string;
  tooltip?: string;
};

export const starterFeatures: PlanFeature[] = [
  {
    label: "Invoicing and payments",
    tooltip:
      "Recurring schedules, templates, customer portal, and online card payments.",
  },
  {
    label: "Transactions and bank sync",
    tooltip:
      "Connect to 20,000+ banks. Transactions categorized automatically.",
  },
  {
    label: "Inbox and receipt matching",
    tooltip:
      "Forward receipts from Gmail, Outlook, Slack, or WhatsApp. Matched to transactions automatically.",
  },
  {
    label: "Accounting exports",
    tooltip: "Export to Xero, QuickBooks, Fortnox, or CSV with one click.",
  },
  {
    label: "Time tracking",
    tooltip: "Track billable hours per project and turn them into invoices.",
  },
  {
    label: "Financial metrics",
    tooltip:
      "Track revenue, burn rate, profit, expenses, and runway with customizable dashboards.",
  },
  {
    label: "Financial overview and reports",
    tooltip:
      "Live dashboard with profit & loss, burn rate, runway, cash flow, and tax summaries.",
  },
  {
    label: "Vault",
    tooltip:
      "Store and organize documents. Attach to transactions and invoices.",
  },
  {
    label: "Apps and integrations",
    tooltip: "Slack, Gmail, Outlook, Stripe, Google Drive, Dropbox, and more.",
  },
  {
    label: "5 AI Connectors",
    tooltip:
      "Connect up to 5 of 60+ tools like Linear, Notion, HubSpot, and GitHub to the AI assistant.",
  },
  {
    label: "Multi-currency",
    tooltip:
      "Invoice in any currency. Converted to your base currency automatically.",
  },
  {
    label: "Customer management",
    tooltip:
      "Store customer details, track history, and reuse across invoices and projects.",
  },
  {
    label: "API, CLI, and MCP",
    tooltip:
      "REST API, CLI, SDKs, and MCP server for AI agents and custom workflows.",
  },
  { label: "3 banks · 15 invoices/mo · 10GB storage" },
];

export const proFeatures: PlanFeature[] = [
  { label: "Everything in Starter" },
  { label: "10 banks · 50 invoices/mo · 100GB storage" },
  {
    label: "20 AI Connectors",
    tooltip:
      "Connect up to 20 of 60+ tools like Linear, Notion, HubSpot, Figma, and more to the AI assistant.",
  },
  {
    label: "Custom transaction categories",
    tooltip:
      "Create your own categories and rules to match how your business operates.",
  },
  {
    label: "Invoice templates",
    tooltip:
      "Save and reuse invoice layouts for different clients or services.",
  },
  {
    label: "Customer portal",
    tooltip:
      "Let customers view and pay invoices through their own branded portal.",
  },
  {
    label: "Customer enrichment",
    tooltip:
      "Automatically enrich customer profiles with company details, social links, funding info, and more.",
  },
  {
    label: "Advanced metrics",
    tooltip:
      "Revenue forecasting, category breakdowns, and detailed financial analysis across your business.",
  },
  {
    label: "Advanced AI thinking",
    tooltip:
      "Deep analysis mode with extended reasoning for complex financial questions.",
  },
  {
    label: "Shareable report and document links",
    tooltip:
      "Generate view-only links with optional expiration for reports, receipts, and vault documents.",
  },
  // {
  //   label: "E-Invoicing (Peppol)",
  //   tooltip:
  //     "Send and receive e-invoices via the Peppol network for EU/global compliance.",
  // },
  { label: "Priority support" },
];

/** @deprecated Use starterFeatures instead */
export const planFeatures = starterFeatures;

export function getPlanLimits(plan: string): PlanLimits {
  switch (plan) {
    case "starter":
      return {
        users: 2,
        bankConnections: 3,
        connectors: 5,
        storage: 10 * 1024 * 1024 * 1024,
        inbox: 150,
        invoices: 15,
      };
    case "trial":
    case "pro":
      return {
        users: 10,
        bankConnections: 10,
        connectors: 20,
        storage: 100 * 1024 * 1024 * 1024,
        inbox: 500,
        invoices: 50,
      };
    default:
      return {
        users: 1,
        bankConnections: 1,
        connectors: 2,
        storage: 1 * 1024 * 1024 * 1024,
        inbox: 50,
        invoices: 5,
      };
  }
}
