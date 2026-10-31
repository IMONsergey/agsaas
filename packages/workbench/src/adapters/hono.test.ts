import { describe, expect, it } from "bun:test";
import type { Queue } from "bullmq";
import { workbench } from "./hono";

// No connection options: constructing the real adapter must not create Redis clients.
const queue = { name: "local-test", opts: {} } as Queue;

describe("Workbench static asset boundary", () => {
  it("does not serve source files through encoded path separators", async () => {
    const app = workbench([queue]);
    const response = await app.request(
      "/assets/%2e%2e%2f%2e%2e%2fcore%2fworkbench.ts",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("class WorkbenchCore");
  });
});
