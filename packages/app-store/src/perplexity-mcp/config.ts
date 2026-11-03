import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Perplexity",
  id: "perplexity-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect Perplexity to your AGSaaS data with AI-powered search.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect Perplexity to your AGSaaS account using the Model Context Protocol (MCP).

**What you can do:**
- Query your financial data using natural language
- Get instant answers about transactions, invoices, and reports
- Combine Perplexity's AI search with your real business data

**Server URL:** \`${mcpUrl}\`

**How it works:**
1. Open your client's MCP server settings
2. Add the MCP server configuration to Perplexity
3. Add your AGSaaS API key and start asking questions`;
  },
  images: [],
};
