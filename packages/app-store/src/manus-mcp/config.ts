import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Manus",
  id: "manus-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description: "Connect Manus to your AGSaaS financial data via MCP.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect Manus to your AGSaaS account using the Model Context Protocol (MCP).

**What you can do:**
- Query transactions, invoices, and reports in Manus
- Get financial insights grounded in your real business data
- Automate workflows with your financial data
- Create reports and summaries using natural language

**Setup steps:**
1. In Manus, go to **Settings** and add a new MCP connector
2. Enter the server URL: \`${mcpUrl}\`
3. Authenticate with your AGSaaS account when prompted

**Requirements:** Manus account with MCP connector support.`;
  },
  images: [],
};
