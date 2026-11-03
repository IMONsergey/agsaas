/** Pure auth/business suites stub only the independent resource admission boundary.
 * Never preload this file for resource-admission.test.ts or PostgreSQL budget suites. */
import { mock } from "bun:test";
import type { MiddlewareHandler } from "hono";

const withResourceAdmission: MiddlewareHandler = async (_context, next) => {
  await next();
};
mock.module("@api/utils/resource-admission", () => ({
  admitTrpcRequest: async () => {},
  admitFileRequest: async () => {},
  withResourceAdmission,
}));
