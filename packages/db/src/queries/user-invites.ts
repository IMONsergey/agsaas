import { and, eq, inArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database, DatabaseOrTransaction } from "../client";
import {
  teamInviteDeliveries,
  teams,
  userInvites,
  users,
  usersOnTeam,
} from "../schema";
import type { TeamInviteEmailContext } from "../team-invite-delivery";
import {
  lockTeamMembership,
  lockUserMembership,
  requireTeamMember,
  requireTeamOwner,
} from "../utils/team-membership";

export async function getUserInvites(db: Database, email: string) {
  return db.query.userInvites.findMany({
    where: eq(userInvites.email, email),
    with: {
      user: {
        columns: {
          id: true,
          fullName: true,
          email: true,
        },
      },
      team: {
        columns: {
          id: true,
          name: true,
          logoUrl: true,
        },
      },
    },
    columns: {
      id: true,
      email: true,
      code: true,
      role: true,
    },
  });
}

type AcceptTeamInviteParams = {
  id: string;
  userId: string;
  userEmail: string;
};

export async function acceptTeamInvite(
  db: Database,
  params: AcceptTeamInviteParams,
) {
  return db.transaction(async (tx) => {
    await lockUserMembership(tx, params.userId);
    const candidate = await tx.query.userInvites.findFirst({
      where: eq(userInvites.id, params.id),
      columns: { teamId: true },
    });
    if (!candidate?.teamId) throw new Error("Invite not found");

    // Same lock order as create/remove/demote/delete: user guard, then team.
    const members = await lockTeamMembership(tx, candidate.teamId);
    const [inviteData] = await tx
      .select({
        id: userInvites.id,
        role: userInvites.role,
        teamId: userInvites.teamId,
        email: userInvites.email,
      })
      .from(userInvites)
      .where(
        and(
          eq(userInvites.id, params.id),
          eq(userInvites.teamId, candidate.teamId),
        ),
      )
      .for("update");
    if (!inviteData) throw new Error("Invite not found");

    const inviteEmail = inviteData.email?.trim().toLowerCase();
    if (!inviteEmail || inviteEmail !== params.userEmail.trim().toLowerCase()) {
      throw new Error("Invite was sent to a different email address");
    }

    // Concurrent acceptance cannot create a second membership. Existing
    // memberships are not silently upgraded by an old pending invitation.
    if (!members.some((member) => member.userId === params.userId)) {
      await tx.insert(usersOnTeam).values({
        userId: params.userId,
        role: inviteData.role,
        teamId: candidate.teamId,
      });
    }
    await tx.delete(userInvites).where(eq(userInvites.id, inviteData.id));
    return inviteData;
  });
}

type DeclineTeamInviteParams = {
  id: string;
  email: string;
};

export async function declineTeamInvite(
  db: Database,
  params: DeclineTeamInviteParams,
) {
  const { id, email } = params;

  return db
    .delete(userInvites)
    .where(and(eq(userInvites.id, id), eq(userInvites.email, email)));
}

export async function getTeamInvites(db: Database, teamId: string) {
  const invites = await db.query.userInvites.findMany({
    where: eq(userInvites.teamId, teamId),
    columns: {
      id: true,
      email: true,
      code: true,
      role: true,
    },
    with: {
      user: {
        columns: {
          id: true,
          fullName: true,
          email: true,
        },
      },
      team: {
        columns: {
          id: true,
          name: true,
          logoUrl: true,
        },
      },
    },
  });
  if (invites.length === 0) return [];
  const deliveries = await db
    .select({
      inviteId: teamInviteDeliveries.inviteId,
      status: teamInviteDeliveries.status,
      acceptedAt: teamInviteDeliveries.acceptedAt,
      errorCode: teamInviteDeliveries.lastError,
    })
    .from(teamInviteDeliveries)
    .where(
      and(
        eq(teamInviteDeliveries.teamId, teamId),
        inArray(
          teamInviteDeliveries.inviteId,
          invites.map((invite) => invite.id),
        ),
      ),
    );
  const byInvite = new Map(
    deliveries.map((delivery) => [delivery.inviteId, delivery]),
  );
  return invites.map((invite) => {
    const delivery = byInvite.get(invite.id);
    return {
      ...invite,
      delivery: delivery
        ? {
            status: delivery.status,
            acceptedAt: delivery.acceptedAt,
            errorCode: delivery.errorCode,
          }
        : null,
    };
  });
}

export async function getInvitesByEmail(db: Database, email: string) {
  return db.query.userInvites.findMany({
    where: eq(userInvites.email, email),
    columns: {
      id: true,
      email: true,
      code: true,
      role: true,
    },
    with: {
      user: {
        columns: {
          id: true,
          fullName: true,
          email: true,
        },
      },
      team: {
        columns: {
          id: true,
          name: true,
          logoUrl: true,
        },
      },
    },
  });
}

type DeleteTeamInviteParams = {
  id: string;
  teamId: string;
  actorId: string;
};

export async function deleteTeamInvite(
  db: Database,
  params: DeleteTeamInviteParams,
) {
  return db.transaction(async (tx) => {
    const members = await lockTeamMembership(tx, params.teamId);
    requireTeamMember(members, params.actorId);
    const [deleted] = await tx
      .delete(userInvites)
      .where(
        and(
          eq(userInvites.id, params.id),
          eq(userInvites.teamId, params.teamId),
        ),
      )
      .returning();
    return deleted;
  });
}

type CreateTeamInvitesParams = {
  teamId: string;
  actorId: string;
  deliveryContext?: Pick<
    TeamInviteEmailContext,
    "invitedByName" | "invitedByEmail" | "locale" | "ip"
  >;
  invites: {
    email: string;
    role: "owner" | "member";
    invitedBy: string;
  }[];
};

type InviteValidationResult = {
  validInvites: {
    email: string;
    role: "owner" | "member";
    invitedBy: string;
  }[];
  skippedInvites: {
    email: string;
    reason: "already_member" | "already_invited" | "duplicate";
  }[];
};

/**
 * Validates invites by checking for existing team members, pending invites, and duplicates
 */
async function validateInvites(
  db: DatabaseOrTransaction,
  teamId: string,
  invites: {
    email: string;
    role: "owner" | "member";
    invitedBy: string;
  }[],
): Promise<InviteValidationResult> {
  const seen = new Set<string>();
  const duplicateInvites: InviteValidationResult["skippedInvites"] = [];
  const uniqueInvites = invites.filter((invite) => {
    const email = invite.email.toLowerCase();
    if (seen.has(email)) {
      duplicateInvites.push({ email: invite.email, reason: "duplicate" });
      return false;
    }
    seen.add(email);
    return true;
  });

  const emails = uniqueInvites.map((invite) => invite.email.toLowerCase());

  // Check for existing team members
  const existingMembers = await db
    .select({
      email: users.email,
    })
    .from(usersOnTeam)
    .innerJoin(users, eq(usersOnTeam.userId, users.id))
    .where(
      and(
        eq(usersOnTeam.teamId, teamId),
        or(...emails.map((email) => sql`LOWER(${users.email}) = ${email}`)),
      ),
    );

  const existingMemberEmails = new Set(
    existingMembers
      .map((member) => member.email?.toLowerCase())
      .filter(Boolean),
  );

  // Check for pending invites
  const pendingInvites = await db
    .select({
      email: userInvites.email,
    })
    .from(userInvites)
    .where(
      and(
        eq(userInvites.teamId, teamId),
        or(
          ...emails.map((email) => sql`LOWER(${userInvites.email}) = ${email}`),
        ),
      ),
    );

  const pendingInviteEmails = new Set(
    pendingInvites.map((invite) => invite.email?.toLowerCase()).filter(Boolean),
  );

  const validInvites: typeof uniqueInvites = [];
  const skippedInvites: {
    email: string;
    reason: "already_member" | "already_invited" | "duplicate";
  }[] = [...duplicateInvites];

  // Process each invite
  for (const invite of uniqueInvites) {
    const emailLower = invite.email.toLowerCase();

    if (existingMemberEmails.has(emailLower)) {
      skippedInvites.push({
        email: invite.email,
        reason: "already_member",
      });
    } else if (pendingInviteEmails.has(emailLower)) {
      skippedInvites.push({
        email: invite.email,
        reason: "already_invited",
      });
    } else {
      validInvites.push(invite);
    }
  }

  return { validInvites, skippedInvites };
}

export async function createTeamInvites(
  db: DatabaseOrTransaction,
  params: CreateTeamInvitesParams,
) {
  const { teamId, actorId } = params;
  if (params.invites.length < 1 || params.invites.length > 50)
    throw new Error("Invite between 1 and 50 people at a time");
  const invites = params.invites.map((invite) => ({
    ...invite,
    email: invite.email.trim().toLowerCase(),
    invitedBy: actorId,
  }));
  if (
    invites.some(
      (invite) =>
        invite.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invite.email) ||
        !["owner", "member"].includes(invite.role),
    )
  )
    throw new Error("Invalid invitation");

  return db.transaction(async (tx) => {
    // Same lock order as membership acquisition and account deletion.
    await lockUserMembership(tx, actorId);
    const members = await lockTeamMembership(tx, teamId);
    requireTeamMember(members, actorId);
    if (invites.some((invite) => invite.role === "owner"))
      requireTeamOwner(members, actorId);
    const { validInvites, skippedInvites } = await validateInvites(
      tx,
      teamId,
      invites,
    );
    const [actor] = await tx
      .select({ email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, actorId));
    const [team] = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.id, teamId));
    if (!actor || !team) throw new Error("Invitation actor or team not found");
    const invitedByEmail =
      params.deliveryContext?.invitedByEmail ?? actor.email;
    if (!invitedByEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitedByEmail))
      throw new Error("Invitation actor email is required");
    const plain = (value: string) =>
      value.replace(/[\r\n]/g, " ").slice(0, 200);
    const context: TeamInviteEmailContext = {
      invitedByName: plain(
        params.deliveryContext?.invitedByName ?? actor.fullName ?? "",
      ),
      invitedByEmail,
      teamName: plain(team.name ?? ""),
      locale: params.deliveryContext?.locale ?? "en",
      ...(params.deliveryContext?.ip
        ? { ip: params.deliveryContext.ip.slice(0, 64) }
        : {}),
    };
    const results = [];
    for (const invite of validInvites) {
      const [row] = await tx
        .insert(userInvites)
        .values({ ...invite, code: nanoid(24), teamId })
        .onConflictDoNothing({
          target: [userInvites.teamId, userInvites.email],
        })
        .returning();
      if (!row) {
        skippedInvites.push({ email: invite.email, reason: "already_invited" });
        continue;
      }
      // Intent and invitation commit together. Losing Redis cannot lose this email.
      const [delivery] = await tx
        .insert(teamInviteDeliveries)
        .values({ teamId, inviteId: row.id, recipient: invite.email, context })
        .returning({ id: teamInviteDeliveries.id });
      if (!delivery)
        throw new Error("Invitation delivery intent was not persisted");
      results.push({
        id: row.id,
        deliveryId: delivery.id,
        email: row.email,
        code: row.code,
        role: row.role,
        team,
      });
    }
    return { results, skippedInvites };
  });
}
