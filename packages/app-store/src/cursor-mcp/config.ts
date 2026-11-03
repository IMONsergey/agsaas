import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Cursor",
  id: "cursor-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect Cursor to your AGSaaS data via MCP. Ask questions about finances while you code.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect Cursor to your AGSaaS account using the Model Context Protocol (MCP). No API key needed — authentication is handled automatically via OAuth.

**What you can do:**
- Track time and log expenses without leaving your editor
- Ask about transactions, invoices, and customers
- Generate financial reports and summaries
- Query your business data using natural language

**Server URL:** \`${mcpUrl}\`

**How it works:**
1. Open your client's MCP server settings
2. Add the MCP server to Cursor
3. When you first use a AGSaaS tool, sign in and select a team`;
  },
  images: [],
};
