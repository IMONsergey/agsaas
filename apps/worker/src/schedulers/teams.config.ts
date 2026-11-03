import type { StaticSchedulerConfig } from "../types/scheduler-config";

export const teamsStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "reconcile-bank-sync",
    queue: "teams",
    cron: "* * * * *",
    jobName: "reconcile-bank-sync",
    payload: {},
    options: { tz: "UTC" },
  },
  {
    name: "reconcile-onboarding",
    queue: "teams",
    cron: "* * * * *",
    jobName: "reconcile-onboarding",
    payload: {},
    options: { tz: "UTC" },
  },
  {
    name: "reconcile-resource-cleanups",
    queue: "teams",
    cron: "* * * * *",
    jobName: "reconcile-resource-cleanups",
    payload: {},
    options: { tz: "UTC" },
  },
  {
    name: "reconcile-bank-connections",
    queue: "teams",
    cron: "* * * * *",
    jobName: "reconcile-bank-connections",
    payload: {},
    options: { tz: "UTC" },
  },
  {
    name: "reconcile-team-invitations",
    queue: "teams",
    cron: "* * * * *",
    jobName: "reconcile-team-invitations",
    payload: {},
    options: { tz: "UTC" },
  },
];
