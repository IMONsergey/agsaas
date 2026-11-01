import { afterAll, describe, expect, test } from "bun:test";
import { createTeamSchema, updateTeamByIdSchema } from "../../schemas/team";
import { updateUserSchema } from "../../schemas/users";
import { isOwnPublicAvatarUrl } from "../../utils/public-avatar-url";

const origin = "https://preview.example.test:8545";
const prefix = "/storage/v1/object/public/avatars/";
const env = { SUPABASE_URL: origin };
const original = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
};
process.env.SUPABASE_URL = origin;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("own Supabase public avatar URL boundary", () => {
  test("allows existing own paths, safe encoded object names, and configured HTTP stage", () => {
    for (const path of [
      "user-id/avatar.jpg",
      "team-id/company-logo.png",
      "legacy/old%20name.png",
      "legacy/%D1%84%D0%BE%D1%82%D0%BE.png",
    ]) {
      expect(isOwnPublicAvatarUrl(origin + prefix + path, env)).toBe(true);
    }
    expect(
      isOwnPublicAvatarUrl(
        "http://127.0.0.1:8000" + prefix + "user/avatar.png",
        { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:8000" },
      ),
    ).toBe(true);
  });

  test("rejects foreign origin, port, credential tricks, query substrings and upstream URLs", () => {
    for (const value of [
      "https://evil.test/" + origin + prefix + "avatar.png",
      "https://preview.example.test.evil.test:8545" + prefix + "avatar.png",
      "https://preview.example.test:8544" + prefix + "avatar.png",
      "https://user:pass@preview.example.test:8545" + prefix + "avatar.png",
      "https://cdn.midday.ai/avatars/avatar.png",
      "https://evil.test/avatar.png?from=midday.ai",
      origin + prefix + "avatar.png?download=true",
      origin + prefix + "avatar.png#fragment",
      "ftp://preview.example.test:8545" + prefix + "avatar.png",
    ])
      expect(isOwnPublicAvatarUrl(value, env)).toBe(false);
  });

  test("rejects another bucket, empty paths and raw/encoded traversal before URL normalization", () => {
    for (const path of [
      "/storage/v1/object/public/vault/file.png",
      prefix,
      prefix + "/file.png",
      prefix + "../vault/file.png",
      prefix + "user/../file.png",
      prefix + "user/%2e%2e/file.png",
      prefix + "user/%252e%252e/file.png",
      prefix + "user/file%2fother.png",
      prefix + "user/file%5cother.png",
      prefix + "user/\\file.png",
      prefix + "user/%00.png",
      prefix + "user/%bad.png",
      prefix + "user/%23.png",
      prefix + "user/%3f.png",
    ])
      expect(isOwnPublicAvatarUrl(origin + path, env)).toBe(false);
  });

  test("missing or malformed configuration never expands the allowed origins", () => {
    const url = origin + prefix + "user/avatar.jpg";
    expect(isOwnPublicAvatarUrl(url, {})).toBe(false);
    expect(
      isOwnPublicAvatarUrl(url, {
        SUPABASE_URL: "https://user:secret@preview.example.test:8545",
      }),
    ).toBe(false);
    expect(
      isOwnPublicAvatarUrl(url, { SUPABASE_URL: origin + "/arbitrary/path" }),
    ).toBe(false);
    expect(
      isOwnPublicAvatarUrl(url, {
        SUPABASE_URL: "invalid",
        NEXT_PUBLIC_SUPABASE_URL: origin,
      }),
    ).toBe(true);
  });

  test("all three real input schemas accept own upload output and reject the former substring bypass", () => {
    const own = origin + prefix + "user-id/avatar.jpg";
    const foreign = "https://evil.test/image.png?trusted=midday.ai";
    expect(updateUserSchema.safeParse({ avatarUrl: own }).success).toBe(true);
    expect(updateTeamByIdSchema.safeParse({ logoUrl: own }).success).toBe(true);
    expect(createTeamSchema.shape.logoUrl.safeParse(own).success).toBe(true);
    expect(updateUserSchema.safeParse({ avatarUrl: foreign }).success).toBe(
      false,
    );
    expect(updateTeamByIdSchema.safeParse({ logoUrl: foreign }).success).toBe(
      false,
    );
    expect(createTeamSchema.shape.logoUrl.safeParse(foreign).success).toBe(
      false,
    );
  });
});
