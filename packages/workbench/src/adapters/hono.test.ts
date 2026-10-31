import { describe, expect, it, spyOn } from "bun:test";
import type { Queue } from "bullmq";
import { WorkbenchCore } from "../core/workbench";
import { workbench } from "./hono";

// No connection options: constructing the real adapter must not create Redis clients.
const queue = { name: "local-test", opts: {} } as Queue;

describe("Workbench static asset boundary", () => {
  it("exposes additive close without changing its Hono routes", async () => {
    const close = spyOn(WorkbenchCore.prototype, "close").mockResolvedValue();
    try {
      const app = workbench([queue]);
      expect((await app.request("/config")).status).toBe(200);
      await app.close();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it("does not serve source files through encoded path separators", async () => {
    const app = workbench([queue]);
    const response = await app.request(
      "/assets/%2e%2e%2f%2e%2e%2fcore%2fworkbench.ts",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("class WorkbenchCore");
  });
});
