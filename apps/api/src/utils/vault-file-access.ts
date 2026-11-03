import type { Context as ApiContext } from "@api/rest/types";
import type { Database } from "@midday/db/client";
import { validateExportArchiveReceipt } from "@midday/db/export-archive-receipt";
import { getExportFileAccessReceipts } from "@midday/db/queries/export-file-access";
import { requireVaultPathForTeam } from "@midday/utils/storage-path";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Scope } from "./scopes";

export type VaultReadPrincipal = {
  teamId: string;
  // Set only after verified browser session/file-capability authentication.
  interactive: boolean;
  scopes: readonly Scope[];
};

type VaultDocument = { pathTokens?: string[] | null };

export function vaultReadPrincipalFromRequest(
  c: Context<ApiContext>,
): VaultReadPrincipal {
  return {
    teamId: c.get("teamId"),
    interactive:
      c.get("authType") === "session" && !!c.get("session")?.sessionId,
    scopes: c.get("scopes") ?? [],
  };
}

function normalizedPath(path: string, teamId: string): string | null {
  try {
    return requireVaultPathForTeam(path, teamId).normalizedPath;
  } catch {
    return null;
  }
}

function exportOperation(path: string): string | null {
  const parts = path.split("/");
  if (
    parts.length !== 4 ||
    parts[1] !== "exports" ||
    !/^[a-f0-9]{64}$/.test(parts[2]!) ||
    !/^[a-f0-9]{64}\.zip$/.test(parts[3]!)
  )
    return null;
  return parts[2]!;
}

/**
 * Browser members retain the same full export/read/share authority as tRPC.
 * Scoped clients need transactions.read and a verified transaction-only
 * receipt. Full-team, unknown and malformed reserved exports stay session-only.
 */
async function readableVaultPaths(
  db: Database,
  principal: VaultReadPrincipal,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length > 100)
    throw new HTTPException(400, { message: "Too many file paths." });
  const normalized = new Set(
    paths
      .map((path) => normalizedPath(path, principal.teamId))
      .filter((path): path is string => path !== null),
  );
  const allowed = new Set<string>();
  const pending = new Map<string, string>();
  for (const path of normalized) {
    if (principal.interactive || path.split("/")[1] !== "exports") {
      allowed.add(path);
      continue;
    }
    if (!principal.scopes.includes("transactions.read")) continue;
    const operationId = exportOperation(path);
    if (operationId) pending.set(path, operationId);
  }
  if (pending.size === 0) return allowed;

  let rows: Awaited<ReturnType<typeof getExportFileAccessReceipts>>;
  try {
    rows = await getExportFileAccessReceipts(db, {
      teamId: principal.teamId,
      operationIds: [...new Set(pending.values())],
    });
  } catch {
    throw new HTTPException(503, {
      message: "Export file access could not be verified.",
    });
  }
  for (const row of rows) {
    const receipt = validateExportArchiveReceipt(row, principal.teamId);
    if (
      receipt?.kind === "transactions" &&
      row.transaction_assets_safe === true &&
      pending.get(receipt.path) === row.operation_key
    )
      allowed.add(receipt.path);
  }
  return allowed;
}

export async function assertVaultFileReadAccess(
  db: Database,
  principal: VaultReadPrincipal,
  path: string,
): Promise<string> {
  const normalized = normalizedPath(path, principal.teamId);
  const allowed = await readableVaultPaths(db, principal, [path]);
  if (!normalized || !allowed.has(normalized))
    throw new HTTPException(403, {
      message: "No permission to access this file.",
    });
  return normalized;
}

export async function filterReadableVaultDocuments<T extends VaultDocument>(
  db: Database,
  principal: VaultReadPrincipal,
  documents: readonly T[],
): Promise<T[]> {
  if (principal.interactive) return [...documents];
  const paths = documents.map(
    (document) => document.pathTokens?.join("/") ?? "",
  );
  const allowed = await readableVaultPaths(db, principal, paths);
  return documents.filter((_, index) => {
    const path = normalizedPath(paths[index]!, principal.teamId);
    return path !== null && allowed.has(path);
  });
}
