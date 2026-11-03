import type { StaticSchedulerConfig } from "../types/scheduler-config";
export const customersStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "reconcile-customer-enrichment",
    queue: "customers",
    cron: "* * * * *",
    jobName: "reconcile-customer-enrichment",
    payload: {},
    options: { tz: "UTC" },
  },
];
