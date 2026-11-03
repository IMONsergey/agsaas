import { afterEach, expect, test } from "bun:test";
import { apps } from "./index";

const keys = [
  "NODE_ENV",
  "API_URL",
  "MIDDAY_API_URL",
  "NEXT_PUBLIC_API_URL",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("all MCP catalog descriptions use the configured API including its port", () => {
  process.env.NODE_ENV = "production";
  process.env.API_URL = "https://api.owned.example:8443";
  const mcpApps = apps.filter((app) => app.id.endsWith("-mcp"));
  expect(mcpApps.length).toBe(15);
  for (const app of mcpApps) {
    expect(app.description).toContain("https://api.owned.example:8443/mcp");
    expect(app.description).not.toContain("midday.ai");
    expect(app.description).not.toContain("Click Install");
    expect("installUrl" in app).toBe(false);
  }
});

test("MCP catalog configuration is read when needed and fails closed without a production origin", () => {
  process.env.NODE_ENV = "production";
  for (const key of keys.filter((key) => key !== "NODE_ENV"))
    delete process.env[key];
  const app = apps.find((entry) => entry.id === "claude-mcp");
  expect(() => app?.description).toThrow("must be configured");
  process.env.NEXT_PUBLIC_API_URL = "https://other-owned.example:8554";
  expect(app?.description).toContain("https://other-owned.example:8554/mcp");
});
