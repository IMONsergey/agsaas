import { sql } from "drizzle-orm";
import type { Database, TransactionClient } from "../../client";
import { users } from "../../schema";

interface TestProfile {
  id: string;
  teamId: string;
  fullName: string;
  email: string;
}

/** Seed only generated fixture IDs, inside the guarded test transaction. */
export async function seedTestProfiles(
  tx: TransactionClient,
  profiles: readonly TestProfile[],
): Promise<void> {
  for (const profile of profiles) {
    // The real Auth bridge may already create public.users synchronously.
    // Use only the Auth columns provided by both Supabase and the test foundation.
    await tx.execute(sql`
      INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES (${profile.id}::uuid, ${profile.email},
        ${JSON.stringify({ full_name: profile.fullName })}::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        email = excluded.email,
        raw_user_meta_data = excluded.raw_user_meta_data
    `);
    await tx
      .insert(users)
      .values(profile)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          teamId: profile.teamId,
          fullName: profile.fullName,
          email: profile.email,
        },
      });
  }
}

/** Remove only this fixture's Auth identities after deleting its tenant rows. */
export async function removeTestProfiles(
  db: Database | TransactionClient,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(sql`
    DELETE FROM auth.users
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
}
