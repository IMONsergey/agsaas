import type { StaticSchedulerConfig } from "../types/scheduler-config";

export const notificationsStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "reconcile-notification-dispatches",
    queue: "notifications",
    cron: "*/1 * * * *",
    jobName: "reconcile-notification-dispatches",
    payload: {},
    options: { tz: "UTC" },
  },
  {
    name: "activity-notification-flush",
    queue: "notifications",
    cron: "*/1 * * * *",
    jobName: "activity-notification-flush",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
];
