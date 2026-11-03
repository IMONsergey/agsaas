import { expect, test } from "bun:test";
import { publicImagePath } from "./public-image-upload";
const id = "11111111-1111-4111-8111-111111111111";
test("display images have distinct immutable and tenant/user bound paths", () => {
  const file = { type: "image/png", size: 32 };
  const first = publicImagePath(file, id, "team-logo");
  expect(first.slice(0, 3)).toEqual(["teams", id, "logo"]);
  expect(first.at(-1)).toMatch(/^[a-f0-9-]{36}\.png$/);
  expect(publicImagePath(file, id, "team-logo")).not.toEqual(first);
  expect(publicImagePath(file, id, "user-avatar").slice(0, 2)).toEqual([
    "users",
    id,
  ]);
  expect(publicImagePath(file, id, "app-screenshot").slice(0, 2)).toEqual([
    id,
    "screenshots",
  ]);
});
test("active formats, oversize payloads and missing owner cannot become public assets", () => {
  for (const file of [
    { type: "image/svg+xml", size: 1 },
    { type: "text/html", size: 1 },
    { type: "image/png", size: 5242881 },
    { type: "image/png", size: 0 },
  ])
    expect(() => publicImagePath(file, id, "user-avatar")).toThrow();
  expect(() =>
    publicImagePath({ type: "image/png", size: 1 }, "../other", "app-logo"),
  ).toThrow();
});
