import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getApiUrl, validateOrigin } from "../utils/env.js";

export interface Credentials {
  apiOrigin: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  teamName?: string;
  teamId?: string;
  userId?: string;
}

interface Config {
  defaultFormat?: "json" | "table";
}

function getConfigDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "agsaas");
}

function ensureConfigDir(): string {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("AGSaaS configuration must be stored in a real directory");
  }
  fs.chmodSync(dir, 0o700);
  return dir;
}

function credentialsPath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

function configPath(): string {
  return path.join(getConfigDir(), "config.json");
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32768 &&
    !/\s/.test(value)
  );
}

function parseCredentials(
  value: unknown,
  apiOrigin: string,
): Credentials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Legacy upstream credentials, unbound tokens and a different installation are never reused.
  if (
    record.schemaVersion !== 1 ||
    record.apiOrigin !== apiOrigin ||
    !validToken(record.accessToken)
  )
    return null;
  if (record.refreshToken !== undefined && !validToken(record.refreshToken))
    return null;
  if (
    record.expiresAt !== undefined &&
    (typeof record.expiresAt !== "number" ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= Date.now())
  )
    return null;
  for (const key of ["email", "teamName", "teamId", "userId"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string")
      return null;
  }
  return {
    apiOrigin,
    accessToken: record.accessToken,
    refreshToken: record.refreshToken as string | undefined,
    expiresAt: record.expiresAt as number | undefined,
    email: record.email as string | undefined,
    teamName: record.teamName as string | undefined,
    teamId: record.teamId as string | undefined,
    userId: record.userId as string | undefined,
  };
}

export function getCredentials(origin?: string): Credentials | null {
  try {
    const apiOrigin = getApiUrl(origin);
    const dir = fs.lstatSync(getConfigDir());
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0)
      return null;
    const file = credentialsPath();
    const info = fs.lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 131072 ||
      (info.mode & 0o077) !== 0
    )
      return null;
    return parseCredentials(
      JSON.parse(fs.readFileSync(file, "utf-8")),
      apiOrigin,
    );
  } catch {
    return null;
  }
}

/** Atomic replacement also corrects an existing file's permissions without following symlinks. */
function writePrivateJson(name: string, value: unknown): void {
  const dir = ensureConfigDir();
  const temporary = path.join(
    dir,
    "." + name + "." + crypto.randomUUID() + ".tmp",
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, path.join(dir, name));
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function saveCredentials(creds: Credentials): void {
  const apiOrigin = validateOrigin("Credential API origin", creds.apiOrigin);
  const value = { ...creds, apiOrigin, schemaVersion: 1 };
  if (!parseCredentials(value, apiOrigin))
    throw new Error("Invalid or expired CLI credentials");
  writePrivateJson("credentials.json", value);
}

export function clearCredentials(): void {
  try {
    fs.unlinkSync(credentialsPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function getConfig(): Config {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    if (!value || typeof value !== "object") return {};
    const format = (value as Config).defaultFormat;
    return format === "json" || format === "table"
      ? { defaultFormat: format }
      : {};
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  writePrivateJson("config.json", config);
}

export function getToken(apiOrigin: string = getApiUrl()): string | null {
  const target = validateOrigin("Credential destination", apiOrigin);
  const envKey = process.env.AGSAAS_API_KEY ?? process.env.MIDDAY_API_KEY;
  if (envKey !== undefined) {
    // An environment key is bound to the configured origin, never to an unrelated --api-url.
    if (getApiUrl() !== target)
      throw new Error(
        "API key origin differs from --api-url; configure and authenticate the intended installation",
      );
    if (!validToken(envKey)) throw new Error("Invalid API key");
    return envKey;
  }
  return getCredentials(target)?.accessToken ?? null;
}
