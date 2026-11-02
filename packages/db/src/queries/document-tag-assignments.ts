import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { documentTagAssignments } from "../schema";
import { assertTeamOwnership } from "../utils/tenant-ownership";

export type CreateDocumentTagAssignmentParams = {
  documentId: string;
  tagId: string;
  teamId: string;
};

export const createDocumentTagAssignment = async (
  db: Database,
  params: CreateDocumentTagAssignmentParams,
) => {
  return db.transaction(async (tx) => {
    await assertTeamOwnership(tx, params.teamId, "documents", [
      params.documentId,
    ]);
    await assertTeamOwnership(tx, params.teamId, "documentTags", [
      params.tagId,
    ]);

    const [result] = await tx
      .insert(documentTagAssignments)
      .values({
        documentId: params.documentId,
        tagId: params.tagId,
        teamId: params.teamId,
      })
      .returning();

    return result;
  });
};

export type DeleteDocumentTagAssignmentParams = {
  documentId: string;
  tagId: string;
  teamId: string;
};

export const deleteDocumentTagAssignment = async (
  db: Database,
  params: DeleteDocumentTagAssignmentParams,
) => {
  const [result] = await db
    .delete(documentTagAssignments)
    .where(
      and(
        eq(documentTagAssignments.documentId, params.documentId),
        eq(documentTagAssignments.tagId, params.tagId),
        eq(documentTagAssignments.teamId, params.teamId),
      ),
    )
    .returning();

  return result;
};

export type UpsertDocumentTagAssignmentParams = {
  documentId: string;
  tagId: string;
  teamId: string;
};

export const upsertDocumentTagAssignments = async (
  db: Database,
  params: UpsertDocumentTagAssignmentParams[],
) => {
  if (params.length === 0) {
    return [];
  }

  const assignmentsByTeam = new Map<
    string,
    UpsertDocumentTagAssignmentParams[]
  >();
  for (const assignment of params) {
    const assignments = assignmentsByTeam.get(assignment.teamId) ?? [];
    assignments.push(assignment);
    assignmentsByTeam.set(assignment.teamId, assignments);
  }

  return db.transaction(async (tx) => {
    // Validate the complete batch, including every team, before the first insert.
    for (const [teamId, assignments] of assignmentsByTeam) {
      await assertTeamOwnership(
        tx,
        teamId,
        "documents",
        assignments.map((assignment) => assignment.documentId),
      );
      await assertTeamOwnership(
        tx,
        teamId,
        "documentTags",
        assignments.map((assignment) => assignment.tagId),
      );
    }

    return tx
      .insert(documentTagAssignments)
      .values(params)
      .onConflictDoNothing({
        target: [
          documentTagAssignments.documentId,
          documentTagAssignments.tagId,
        ],
      })
      .returning();
  });
};
