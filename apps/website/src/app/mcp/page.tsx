import Link from "next/link";
import { McpGuide } from "@/components/mcp-guide";
export const metadata = { title: "MCP connections" };
export default function Page() {
  return (
    <>
      <McpGuide />
      <nav
        aria-label="MCP clients"
        className="max-w-3xl mx-auto px-8 flex flex-wrap gap-4"
      >
        <Link href="/mcp/chatgpt" className="underline">
          ChatGPT
        </Link>
        <Link href="/mcp/claude" className="underline">
          Claude
        </Link>
        <Link href="/mcp/copilot" className="underline">
          Copilot
        </Link>
        <Link href="/mcp/cursor" className="underline">
          Cursor
        </Link>
        <Link href="/mcp/windsurf" className="underline">
          Windsurf
        </Link>
        <Link href="/mcp/manus" className="underline">
          Manus
        </Link>
        <Link href="/mcp/cline" className="underline">
          Cline
        </Link>
        <Link href="/mcp/zed" className="underline">
          Zed
        </Link>
        <Link href="/mcp/opencode" className="underline">
          OpenCode
        </Link>
        <Link href="/mcp/raycast" className="underline">
          Raycast
        </Link>
        <Link href="/mcp/zapier" className="underline">
          Zapier
        </Link>
        <Link href="/mcp/n8n" className="underline">
          n8n
        </Link>
        <Link href="/mcp/gemini" className="underline">
          Gemini
        </Link>
        <Link href="/mcp/make" className="underline">
          Make
        </Link>
        <Link href="/mcp/perplexity" className="underline">
          Perplexity
        </Link>
      </nav>
    </>
  );
}
