import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "ChatGPT",
  id: "chatgpt-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect ChatGPT to your AGSaaS financial data via MCP with one-click OAuth.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect ChatGPT to your AGSaaS account using the Model Context Protocol (MCP). No API key needed — authentication is handled automatically via OAuth.

**What you can do:**
- Query transactions, invoices, and reports in ChatGPT
- Get financial insights grounded in your real business data
- Create automated reports and summaries
- Use deep research with your private financial data

**Setup steps:**
1. In ChatGPT, go to **Settings → Connectors** and click **Create**
2. Paste this URL as the connector URL: \`${mcpUrl}\`
3. When you use a AGSaaS tool, you'll be prompted to sign in and select a team

**Requirements:** ChatGPT Pro, Plus, Business, Enterprise, or Education account. Enable developer mode in Settings → Apps & Connectors → Advanced settings.`;
  },
  images: [],
};
