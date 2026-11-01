import type { StaticSchedulerConfig } from "../types/scheduler-config";

export const teamsStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "reconcile-team-invitations",
    queue: "teams",
    cron: "* * * * *",
    jobName: "reconcile-team-invitations",
    payload: {},
    options: { tz: "UTC" },
  },
];
