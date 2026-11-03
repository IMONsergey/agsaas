import type { StaticSchedulerConfig } from "../types/scheduler-config";

export const documentsStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "reconcile-storage-documents",
    queue: "documents",
    cron: "*/1 * * * *",
    jobName: "reconcile-storage-documents",
    payload: {},
    options: { tz: "UTC" },
  },
];
