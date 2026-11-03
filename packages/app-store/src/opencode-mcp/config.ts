import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "OpenCode",
  id: "opencode-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect OpenCode to your AGSaaS data via MCP. Track time for clients from your terminal.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect OpenCode to your AGSaaS account using the Model Context Protocol (MCP).

**What you can do:**
- Track time for client projects while you code
- Start/stop timers and log hours from your terminal
- Ask about transactions, invoices, and customers
- Query your business data using natural language

**Server URL:** \`${mcpUrl}\`

**How it works:**
1. Install OpenCode via curl, npm, bun, or brew
2. Add your AGSaaS API key to OpenCode's MCP configuration
3. Restart OpenCode and ask about your AGSaaS data`;
  },
  images: [],
};
