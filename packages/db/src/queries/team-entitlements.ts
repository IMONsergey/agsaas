import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";

export type QuotaResource =
  | "users"
  | "bankConnections"
  | "connectors"
  | "storage"
  | "inbox"
  | "invoices";
export type TeamEntitlements = {
  effectivePlan: "free" | "trial" | "starter" | "pro";
  pastDue: boolean | null;
  trialEndsAt: string | null;
  period: string;
  resetsAt: string;
  limits: Record<QuotaResource, number>;
  usage: Record<QuotaResource, number>;
  storageMetadataComplete: boolean;
};
export type TeamConnectorReservation = {
  id: string;
  teamId: string;
  toolkit: string;
  entityId: string;
  status: "pending" | "active" | "disconnecting" | "unknown" | "released";
  providerAccountId: string | null;
  actorId: string | null;
  createdAt: string;
  updatedAt: string;
};
const connectorColumns = sql`id,team_id as "teamId",toolkit,entity_id as "entityId",status,provider_account_id as "providerAccountId",actor_id as "actorId",created_at::text as "createdAt",updated_at::text as "updatedAt"`;
function primary(db: DatabaseOrTransaction) {
  // biome-ignore lint/correctness/useHookAtTopLevel: Database routing, not React.
  return "usePrimaryOnly" in db ? db.usePrimaryOnly() : db;
}
export async function getTeamEntitlements(
  db: DatabaseOrTransaction,
  teamId: string,
) {
  return (
    await primary(db).execute<{ value: TeamEntitlements }>(
      sql`select public.get_team_entitlements(${teamId}::uuid) as value`,
    )
  ).rows[0]!.value;
}
export async function listTeamConnectors(
  db: DatabaseOrTransaction,
  teamId: string,
) {
  return (
    await primary(db).execute<TeamConnectorReservation>(
      sql`select ${connectorColumns} from team_connector_reservations where team_id=${teamId}::uuid and status<>'released' order by created_at,id`,
    )
  ).rows;
}
export async function reserveTeamConnector(
  db: DatabaseOrTransaction,
  input: { teamId: string; toolkit: string; actorId: string },
) {
  if (!/^[a-z0-9_-]{1,100}$/.test(input.toolkit))
    throw new Error("Invalid connector toolkit");
  return primary(db).transaction(async (tx) => {
    await tx.execute(
      sql`select public.agsaas_quota_lock(${input.teamId}::uuid)`,
    );
    const [existing] = (
      await tx.execute<TeamConnectorReservation>(
        sql`select ${connectorColumns} from team_connector_reservations where team_id=${input.teamId}::uuid and toolkit=${input.toolkit} and status<>'released'`,
      )
    ).rows;
    if (existing) return { ...existing, created: false };
    const [created] = (
      await tx.execute<TeamConnectorReservation>(sql`insert into team_connector_reservations(id,team_id,toolkit,entity_id,actor_id)
   values(${randomUUID()}::uuid,${input.teamId}::uuid,${input.toolkit},${`agsaas-team-${input.teamId}`},${input.actorId}::uuid) returning ${connectorColumns}`)
    ).rows;
    if (!created) throw new Error("Connector reservation was not retained");
    return { ...created, created: true };
  });
}
export async function attachTeamConnector(
  db: DatabaseOrTransaction,
  input: { teamId: string; id: string; providerAccountId: string },
) {
  if (
    !input.providerAccountId ||
    input.providerAccountId.length > 256 ||
    Array.from(input.providerAccountId).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error("Invalid provider connection identity");
  const [row] = (
    await primary(
      db,
    ).execute<TeamConnectorReservation>(sql`update team_connector_reservations set provider_account_id=${input.providerAccountId},status='active',updated_at=clock_timestamp()
  where id=${input.id}::uuid and team_id=${input.teamId}::uuid and (status in ('pending','unknown') or (status='active' and provider_account_id=${input.providerAccountId}))
   and (provider_account_id is null or provider_account_id=${input.providerAccountId}) returning ${connectorColumns}`)
  ).rows;
  if (!row)
    throw new Error(
      "Connector reservation is no longer available for attachment",
    );
  return row;
}
export async function markTeamConnectorDisconnecting(
  db: DatabaseOrTransaction,
  input: { teamId: string; providerAccountId: string },
) {
  const [row] = (
    await primary(
      db,
    ).execute<TeamConnectorReservation>(sql`update team_connector_reservations set status='disconnecting',updated_at=clock_timestamp()
  where team_id=${input.teamId}::uuid and provider_account_id=${input.providerAccountId} and status in ('active','unknown','disconnecting') returning ${connectorColumns}`)
  ).rows;
  if (!row) throw new Error("Connector binding is unavailable");
  return row;
}
/** Caller must establish definitive provider failure/revocation first; unknown outcomes retain the allocation. */
export async function releaseTeamConnector(
  db: DatabaseOrTransaction,
  input: { teamId: string; id?: string; providerAccountId?: string },
) {
  if (!input.id && !input.providerAccountId)
    throw new Error("An exact connector reservation is required");
  const [row] = (
    await primary(
      db,
    ).execute<TeamConnectorReservation>(sql`update team_connector_reservations set status='released',updated_at=clock_timestamp()
  where team_id=${input.teamId}::uuid ${input.id ? sql`and id=${input.id}::uuid` : sql``} ${input.providerAccountId ? sql`and provider_account_id=${input.providerAccountId}` : sql``} returning ${connectorColumns}`)
  ).rows;
  return row ?? null;
}
export async function reserveGeneratedStorage(
  db: DatabaseOrTransaction,
  input: {
    teamId: string;
    path: string;
    sourceKind: "invoice" | "export";
    sourceId: string;
    bytes: number;
  },
) {
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0)
    throw new Error("Invalid generated object size");
  await primary(db).execute(
    sql`select public.reserve_generated_storage(${input.teamId}::uuid,${input.path},${input.sourceKind},${input.sourceId}::uuid,${input.bytes}::bigint)`,
  );
}
