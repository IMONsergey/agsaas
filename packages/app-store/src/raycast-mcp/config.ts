import { getApiUrl } from "@midday/utils/envs";
import { Logo } from "./assets/logo";

export default {
  name: "Raycast",
  id: "raycast-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Access AGSaaS financial data directly from Raycast via MCP.",
  get description() {
    const mcpUrl = getApiUrl() + "/mcp";
    return `Connect Raycast to your AGSaaS account using the Model Context Protocol (MCP).

**What you can do:**
- Quick answers about your finances with a keyboard shortcut
- Check invoice status and customer details
- Query transactions and expenses on the fly
- Access reports without opening your browser

**Server URL:** \`${mcpUrl}\`

**How it works:**
1. Open your client's MCP server settings
2. Add AGSaaS as an MCP server in Raycast
3. @-mention AGSaaS in Raycast AI`;
  },
  images: [],
};
