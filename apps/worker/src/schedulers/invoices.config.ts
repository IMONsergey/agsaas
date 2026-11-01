import type { StaticSchedulerConfig } from "../types/scheduler-config";

/**
 * Static scheduler configurations for invoices
 * These run on fixed schedules and are registered on startup
 */
export const invoicesStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "reconcile-financial-jobs",
    queue: "invoices",
    cron: "* * * * *",
    jobName: "reconcile-financial-jobs",
    payload: {},
    options: { tz: "UTC" },
  },
  {
    name: "reconcile-invoice-deliveries",
    queue: "invoices",
    cron: "* * * * *",
    jobName: "reconcile-invoice-deliveries",
    payload: {},
    options: { tz: "UTC" },
  },
  {
    name: "invoice-recurring-scheduler",
    queue: "invoices",
    cron: "0 * * * *", // Every hour at :00
    jobName: "invoice-recurring-scheduler",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
  {
    name: "invoice-upcoming-notification",
    queue: "invoices",
    cron: "30 * * * *", // Every hour at :30 (offset from recurring scheduler)
    jobName: "invoice-upcoming-notification",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
];
