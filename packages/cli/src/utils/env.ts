import { installationOrigin } from "@midday/utils/envs";

export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

export function isCI(): boolean {
  return Boolean(
    process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI,
  );
}

export function hasNoColor(): boolean {
  return Boolean(process.env.NO_COLOR);
}

export function isAgentMode(flags: {
  json?: boolean;
  agent?: boolean;
  quiet?: boolean;
}): boolean {
  return Boolean(flags.agent || flags.json || !isTTY());
}

export function shouldShowUI(flags: {
  json?: boolean;
  agent?: boolean;
  quiet?: boolean;
}): boolean {
  return !flags.quiet && !flags.agent && !flags.json && isTTY() && !isCI();
}

/** CLI credentials always require an explicit installation, including local development. */
export function validateOrigin(
  name: string,
  value: string | undefined,
): string {
  return installationOrigin(name, value, "", { NODE_ENV: "production" });
}

export function getApiUrl(override?: string): string {
  return validateOrigin(
    "AGSAAS_API_URL",
    override ?? process.env.AGSAAS_API_URL ?? process.env.MIDDAY_API_URL,
  );
}

export function getDashboardUrl(): string {
  return validateOrigin(
    "AGSAAS_DASHBOARD_URL",
    process.env.AGSAAS_DASHBOARD_URL ?? process.env.MIDDAY_DASHBOARD_URL,
  );
}
