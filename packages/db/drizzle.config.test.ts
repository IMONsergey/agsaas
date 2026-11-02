import { defineConfig } from "drizzle-kit";
import { getTestDatabaseUrl } from "./src/test/helpers/test-database-config";

export default defineConfig({
  schema: "./src/test/helpers/test-schema.ts",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url: getTestDatabaseUrl(),
  },
  verbose: true,
});
