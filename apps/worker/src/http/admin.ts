import type { Queue } from "bullmq";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { workbench } from "workbench/hono";

type AdminAuth = { username: string; password: string };
export type WorkerAdminApp = Hono & { close(): Promise<void> };

export function getWorkerAdminAuth(environment: {
  BOARD_USERNAME?: string;
  BOARD_PASSWORD?: string;
}): AdminAuth | undefined {
  if (!environment.BOARD_USERNAME || !environment.BOARD_PASSWORD) {
    return undefined;
  }

  return {
    username: environment.BOARD_USERNAME,
    password: environment.BOARD_PASSWORD,
  };
}

/** Missing credentials disable administration, never authentication. */
export function createWorkerAdminApp({
  queues,
  auth,
}: {
  queues: Queue[];
  auth?: AdminAuth;
}): WorkerAdminApp {
  const closed = Promise.resolve();
  const app = Object.assign(new Hono(), { close: () => closed });
  if (!auth?.username || !auth.password || queues.length === 0) {
    return app;
  }

  app.get("/info", basicAuth(auth), (c) =>
    c.json({
      queues: queues.map((queue) => ({ name: queue.name })),
      dashboardUrl: "/admin/queues",
    }),
  );
  const dashboard = workbench({
    queues,
    auth,
    title: "Midday Jobs",
    tags: ["teamId"],
  });
  app.route("/admin", dashboard);
  app.close = () => dashboard.close();

  return app;
}
