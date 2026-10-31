import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAssetHandler, getAssetPath } from "./static-assets";

describe("static asset names", () => {
  it.each([
    "",
    ".",
    "..",
    "../secret",
    "..\\secret",
    "/secret",
    "nested/file.js",
    "nested\\file.js",
    "file\u0000.js",
    "file\n.js",
    "file\u007f.js",
  ])("rejects non-basename %j", (fileName) => {
    expect(getAssetPath("/test/assets", fileName)).toBeNull();
  });

  it.each([
    "index-aBc123.js",
    "index-aBc123.css",
    "font.woff2",
    "иконка.svg",
  ])("preserves valid asset %s", (fileName) => {
    expect(getAssetPath("/test/assets", fileName)).toBe(
      join("/test/assets", fileName),
    );
  });
});

describe("static asset responses", () => {
  let fixtureDirectory: string;
  let app: Hono;

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "workbench-assets-test-"));
    const assetsDirectory = join(fixtureDirectory, "assets");
    mkdirSync(assetsDirectory);
    mkdirSync(join(assetsDirectory, "directory"));
    writeFileSync(join(fixtureDirectory, "private.txt"), "not a public asset");
    writeFileSync(
      join(assetsDirectory, "bundle.js"),
      "export const ready = true;",
    );
    writeFileSync(
      join(assetsDirectory, "styles.css"),
      "body { color: white; }",
    );
    writeFileSync(
      join(assetsDirectory, "font.woff2"),
      new Uint8Array([0, 1, 2]),
    );
    app = new Hono().get("/assets/:file", createAssetHandler(assetsDirectory));
  });

  afterAll(() => {
    // This directory is created by this suite and contains only its own fixtures.
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true });
  });

  it.each([
    ["bundle.js", "application/javascript", "export const ready = true;"],
    ["styles.css", "text/css", "body { color: white; }"],
  ])("serves %s without changing its content", async (fileName, type, body) => {
    const response = await app.request(`/assets/${fileName}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(await response.text()).toBe(body);
  });

  it("preserves binary assets", async () => {
    const response = await app.request("/assets/font.woff2");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2]),
    );
  });

  it.each([
    "missing.js",
    "directory",
    "..%2fprivate.txt",
    "%2e%2e%2fprivate.txt",
    "..%5cprivate.txt",
    "%00",
    "file%0a.js",
  ])("returns not found for %s", async (fileName) => {
    const response = await app.request(`/assets/${fileName}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
