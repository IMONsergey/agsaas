import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Zed",
  id: "zed-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect Zed to your AGSaaS financial data via MCP with OAuth.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect Zed to your AGSaaS account using the Model Context Protocol (MCP). No API key needed — authentication is handled automatically via OAuth.

**What you can do:**
- Query transactions, invoices, and reports from Zed
- Get financial insights while you code
- Track time and manage invoices without switching apps

**Setup steps:**

**Via Agent Panel:**
1. Open the Agent Panel settings and click **Add Custom Server**
2. Enter the URL: \`${mcpUrl}\`
3. When prompted, sign in to AGSaaS in your browser

**Via settings.json:**
Add to your Zed settings:
\`\`\`json
{
  "context_servers": {
    "midday": {
      "url": "${mcpUrl}"
    }
  }
}
\`\`\`

**Requirements:** Zed editor installed.`;
  },
  images: [],
};
