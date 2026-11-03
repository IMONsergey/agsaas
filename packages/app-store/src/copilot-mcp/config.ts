import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Microsoft Copilot",
  id: "copilot-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect AGSaaS to Microsoft Copilot Studio. Query your business data from Microsoft 365.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect AGSaaS to Microsoft Copilot Studio using the Model Context Protocol (MCP).

**What you can do:**
- Ask about invoices and transactions from Word, Excel, or Outlook
- Generate financial reports through Copilot
- Query your business data using natural language
- Build custom agents that access your AGSaaS data

**Server URL:** \`${mcpUrl}\`

**How it works:**
1. Open Copilot Studio and create or edit an agent
2. Add AGSaaS as an MCP server with your API key
3. Use AGSaaS tools in your Copilot workflows`;
  },
  images: [],
};
