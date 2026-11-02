import { describe, expect, it } from "bun:test";
import {
  matchesJobTags,
  matchesJobText,
  parseSearchQuery,
  searchableJobData,
} from "./job-search";

describe("job search helpers", () => {
  it("separates filters from free text", () => {
    expect(parseSearchQuery("teamId:team-1 invoice")).toEqual({
      filters: { teamId: "team-1" },
      text: "invoice",
    });
  });

  it("supports quoted filters and spaces", () => {
    expect(parseSearchQuery('  customer:"Acme Ltd" paid invoices  ')).toEqual({
      filters: { customer: "Acme Ltd" },
      text: "paid invoices",
    });
  });

  it("keeps incomplete filter tokens as text", () => {
    expect(parseSearchQuery("teamId: invoice")).toEqual({
      filters: {},
      text: "teamId: invoice",
    });
  });

  it("preserves existing unfinished quoted-value behavior", () => {
    expect(parseSearchQuery('teamId:"Acme Ltd')).toEqual({
      filters: { teamId: "Acme Ltd" },
      text: "",
    });
  });

  it("matches tags case-insensitively and supports primitive values", () => {
    expect(
      matchesJobTags(
        { teamId: "TEAM-123", count: 42, active: false },
        { teamId: "team", count: "42", active: "false" },
      ),
    ).toBe(true);
    expect(matchesJobTags({ teamId: null }, { teamId: "null" })).toBe(false);
  });

  it("allows absent data only when there are no tag filters", () => {
    expect(matchesJobTags(undefined, {})).toBe(true);
    expect(matchesJobTags(undefined, { teamId: "team-1" })).toBe(false);
  });

  it("serializes absent data without throwing", () => {
    expect(searchableJobData(undefined)).toBe("");
    expect(searchableJobData({ note: "HELLO" })).toBe('{"note":"hello"}');
  });

  it("matches IDs and names when a job has no data", () => {
    expect(
      matchesJobText({ id: "INV-1", name: "Send", data: undefined }, "inv"),
    ).toBe(true);
    expect(
      matchesJobText({ id: "1", name: "Send", data: undefined }, "missing"),
    ).toBe(false);
  });
});
