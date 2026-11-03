import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Zapier",
  id: "zapier-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect AGSaaS to 7,000+ apps. Automate reports, alerts, and workflows.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect AGSaaS to Zapier using the Model Context Protocol (MCP).

**What you can do:**
- Automate weekly profit reports to email or Slack
- Get alerts when invoices are overdue
- Sync customer data to Google Sheets or your CRM
- Build custom workflows without code

**Server URL:** \`${mcpUrl}\`

**How it works:**
1. Add AGSaaS as an MCP connection in Zapier
2. Use your AGSaaS API key for authentication
3. Create Zaps using AGSaaS's 50+ tools`;
  },
  images: [],
};
