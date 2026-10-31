import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, IndexedColumn } from "drizzle-orm/pg-core";
import { documents, transactions } from "../schema";

const indexCases = [
  {
    table: transactions,
    name: "idx_transactions_team_id_date_name",
    columns: [
      ["team_id", "PgUUID", "uuid_ops"],
      ["date", "PgDateString", "date_ops"],
      ["name", "PgText", "text_ops"],
    ],
  },
  {
    table: transactions,
    name: "idx_transactions_team_id_name",
    columns: [
      ["team_id", "PgUUID", "uuid_ops"],
      ["name", "PgText", "text_ops"],
    ],
  },
  {
    table: transactions,
    name: "transactions_team_id_date_currency_bank_account_id_category_idx",
    columns: [
      ["team_id", "PgUUID", "uuid_ops"],
      ["date", "PgDateString", "date_ops"],
      ["currency", "PgText", "text_ops"],
      ["bank_account_id", "PgUUID", "uuid_ops"],
    ],
  },
  {
    table: documents,
    name: "documents_team_id_parent_id_idx",
    columns: [
      ["team_id", "PgUUID", "uuid_ops"],
      ["parent_id", "PgText", "text_ops"],
    ],
  },
] as const;

describe("composite index declarations", () => {
  for (const { table, name, columns } of indexCases) {
    test(`${name} uses type-compatible operator classes without changing index semantics`, () => {
      const matches = getTableConfig(table).indexes.filter(
        (index) => index.config.name === name,
      );
      expect(matches).toHaveLength(1);

      const config = matches[0]!.config;
      expect(config.method).toBe("btree");
      expect(config.unique).toBe(false);
      expect(config.where).toBeUndefined();
      expect(
        config.columns.map((column) => {
          if (!is(column, IndexedColumn)) {
            throw new Error(`${name} must index columns, not expressions`);
          }
          return {
            name: column.name,
            type: column.type,
            ...column.indexConfig,
          };
        }),
      ).toEqual(
        columns.map(([columnName, type, opClass]) => ({
          name: columnName,
          type,
          opClass,
          order: "asc",
          nulls: "last",
        })),
      );
    });
  }
});
