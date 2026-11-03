import { createHash } from "node:crypto";
import { requireVaultPathForTeam } from "@midday/utils/storage-path";

export type CleanupKind =
  | "provider"
  | "storage-object"
  | "storage-team"
  | "storage-user"
  | "auth-user"
  | "marketing"
  | "billing"
  | "retention";
export type CleanupStatus =
  | "pending"
  | "processing"
  | "completed"
  | "unknown"
  | "manual_required"
  | "failed";
export type CleanupTarget = {
  version: 1;
  kind: CleanupKind;
  teamId: string | null;
  actorUserId: string | null;
  targetId: string;
  provider: string | null;
  data: Record<string, string>;
};
export const cleanupKinds = new Set<CleanupKind>([
  "provider",
  "storage-object",
  "storage-team",
  "storage-user",
  "auth-user",
  "marketing",
  "billing",
  "retention",
]);
export const cleanupDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function cleanupObjectPath(
  teamId: string,
  path: string | readonly string[],
) {
  return requireVaultPathForTeam(path, teamId).normalizedPath;
}
export function validateCleanupTarget(
  value: unknown,
): asserts value is CleanupTarget {
  const v = value as CleanupTarget;
  const uuid = (id: unknown) =>
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (
    !v ||
    v.version !== 1 ||
    !cleanupKinds.has(v.kind) ||
    (v.teamId !== null && !uuid(v.teamId)) ||
    (v.actorUserId !== null && !uuid(v.actorUserId)) ||
    (!v.teamId && !v.actorUserId) ||
    typeof v.targetId !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/.test(v.targetId) ||
    (v.provider !== null && !/^[a-z0-9_-]{1,32}$/.test(v.provider)) ||
    !v.data ||
    typeof v.data !== "object" ||
    Object.entries(v.data).some(
      ([k, x]) =>
        !/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(k) ||
        typeof x !== "string" ||
        x.length > 16384,
    ) ||
    Object.keys(v.data).length > 16
  )
    throw new Error("Invalid cleanup target");
  if (
    v.kind === "provider" &&
    v.provider === "composio" &&
    (!v.teamId ||
      v.data.entityId !== `agsaas-team-${v.teamId}` ||
      v.data.reservationId !== v.targetId ||
      !uuid(v.data.reservationId))
  )
    throw new Error("Invalid connector cleanup binding");
  if (v.kind === "storage-object") {
    if (
      !v.teamId ||
      cleanupObjectPath(v.teamId, v.data.path ?? "") !== v.data.path
    )
      throw new Error("Invalid cleanup path");
  }
  if (v.kind === "storage-team" && v.targetId !== v.teamId)
    throw new Error("Invalid team cleanup");
  if (
    (v.kind === "storage-user" || v.kind === "auth-user") &&
    v.targetId !== v.actorUserId
  )
    throw new Error("Invalid user cleanup");
}
