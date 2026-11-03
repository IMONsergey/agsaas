import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Claude",
  id: "claude-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect Claude to your AGSaaS data via MCP with one-click OAuth.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect Claude to your AGSaaS account using the Model Context Protocol (MCP). No API key needed — authentication is handled automatically via OAuth.

**What you can do:**
- Analyze financial trends and patterns
- Get insights from your transaction history
- Ask questions about invoices, customers, and reports
- Have conversations grounded in your real business data

**Setup steps:**

**Claude.ai / Claude Desktop:**
1. Go to **Settings → Connectors** and click **Add custom connector**
2. Paste this URL as the server URL: \`${mcpUrl}\`
3. When you use a AGSaaS tool, you'll be prompted to sign in and select a team

**Claude Code:**
1. Run: \`claude mcp add --transport http midday ${mcpUrl}\`
2. When prompted, sign in to AGSaaS in your browser
3. Use @midday in Claude Code to access your financial data`;
  },
  images: [],
};
