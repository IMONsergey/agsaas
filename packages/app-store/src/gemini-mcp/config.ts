import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Gemini",
  id: "gemini-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect Gemini CLI to your AGSaaS financial data via MCP with OAuth.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect Gemini CLI to your AGSaaS account using the Model Context Protocol (MCP). No API key needed — authentication is handled automatically via OAuth.

**What you can do:**
- Query transactions, invoices, and reports in Gemini
- Get financial insights grounded in your real business data
- Create automated reports and summaries
- Manage invoices and track time from your terminal

**Setup steps:**
1. Run: \`gemini mcp add --transport http midday ${mcpUrl}\`
2. When prompted, sign in to AGSaaS in your browser and select a team
3. Use AGSaaS tools in Gemini CLI to access your financial data

**Requirements:** Gemini CLI installed (see [Gemini CLI docs](https://github.com/google-gemini/gemini-cli) for installation).`;
  },
  images: [],
};
