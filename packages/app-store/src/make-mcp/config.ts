import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Make",
  id: "make-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect Make scenarios to your AGSaaS data via MCP. Build visual automations with financial tools.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect Make.com to your AGSaaS account using the Model Context Protocol (MCP).

**What you can do:**
- Build visual automations that interact with your financial data
- Create scenarios that query transactions and invoices
- Automate report generation and notifications
- Connect AGSaaS with 1,500+ apps via Make

**Server URL:** \`${mcpUrl}\`

**How it works:**
1. Add the MCP Client module to your Make scenario
2. Configure the AGSaaS MCP server URL and authentication
3. Select tools and map inputs in the visual builder`;
  },
  images: [],
};
