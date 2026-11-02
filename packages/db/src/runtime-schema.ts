import { relations } from "drizzle-orm";
import * as schema from "./schema";

// Drizzle's runtime table map is schema-qualified, but its relational type
// helpers match bare table names. Including auth.users alongside public.users
// therefore merges their inferred relations/results. The application role has
// no Auth-table privileges; managed Auth declarations belong to DDL/reference
// metadata, not the application's relational query surface.
const {
  usersInAuth: _managedAuthTable,
  usersInAuthRelations: _managedAuthRelations,
  usersRelations,
  ...applicationSchema
} = schema;

export const runtimeSchema = {
  ...applicationSchema,
  usersRelations: relations(schema.users, (helpers) => {
    const { usersInAuth: _managedAuthRelation, ...applicationRelations } =
      usersRelations.config(helpers);
    return applicationRelations;
  }),
};
