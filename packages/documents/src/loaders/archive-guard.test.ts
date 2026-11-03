import { describe, expect, it } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { assertBoundedOfficeArchive } from "./archive-guard";

function zip(name: string, text: string, declaredSize?: number) {
  const content = Buffer.from(text),
    compressed = deflateRawSync(content),
    filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize ?? content.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize ?? content.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}
describe("office archive resource boundaries", () => {
  it("accepts a small ordinary entry", () =>
    expect(() =>
      assertBoundedOfficeArchive(
        zip("word/document.xml", "<document>fixture</document>"),
      ),
    ).not.toThrow());
  it("rejects traversal and inconsistent expansion metadata", () => {
    expect(() => assertBoundedOfficeArchive(zip("../escape.xml", "x"))).toThrow(
      "Unsafe",
    );
    expect(() =>
      assertBoundedOfficeArchive(zip("word/document.xml", "x".repeat(4096), 1)),
    ).toThrow();
  });
  it("rejects compressed expansion bombs before parsing office data", () => {
    expect(() =>
      assertBoundedOfficeArchive(
        zip("word/document.xml", "x".repeat(2 * 1024 * 1024)),
      ),
    ).toThrow("expansion");
  });
  it("rejects missing and truncated central directories", () => {
    expect(() => assertBoundedOfficeArchive(Buffer.alloc(30))).toThrow();
    expect(() =>
      assertBoundedOfficeArchive(zip("a", "b").subarray(0, 40)),
    ).toThrow();
  });
});
