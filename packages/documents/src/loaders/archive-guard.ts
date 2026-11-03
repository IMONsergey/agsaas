import { inflateRawSync } from "node:zlib";

const MAX_ENTRIES = 512,
  MAX_EXPANDED = 64 * 1024 * 1024,
  MAX_ENTRY = 16 * 1024 * 1024;
function assertExtraFields(data: Buffer, start: number, length: number) {
  const end = start + length;
  for (let offset = start; offset < end; ) {
    if (offset + 4 > end) throw new Error("Invalid office archive extra field");
    const kind = data.readUInt16LE(offset),
      size = data.readUInt16LE(offset + 2);
    if (offset + 4 + size > end)
      throw new Error("Invalid office archive extra bounds");
    // Alternative sizes and paths must not change the entries validated here.
    if (kind === 0x0001 || kind === 0x7075)
      throw new Error("Unsupported office archive alternate metadata");
    offset += 4 + size;
  }
}
/** ZIP preflight validates actual expansion, not only attacker-supplied sizes. */
export function assertBoundedOfficeArchive(data: Buffer) {
  if (data.length < 22) throw new Error("Invalid office archive");
  let end = -1;
  for (let p = data.length - 22; p >= Math.max(0, data.length - 65557); p--) {
    if (
      data.readUInt32LE(p) === 0x06054b50 &&
      p + 22 + data.readUInt16LE(p + 20) === data.length
    ) {
      end = p;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid office archive directory");
  const entries = data.readUInt16LE(end + 10),
    directorySize = data.readUInt32LE(end + 12),
    directoryOffset = data.readUInt32LE(end + 16);
  if (
    data.readUInt16LE(end + 4) !== 0 ||
    data.readUInt16LE(end + 6) !== 0 ||
    data.readUInt16LE(end + 8) !== entries ||
    entries === 65535 ||
    entries > MAX_ENTRIES ||
    directoryOffset === 0xffffffff ||
    directorySize === 0xffffffff ||
    directoryOffset + directorySize !== end
  )
    throw new Error("Office archive layout exceeds supported limits");
  let offset = directoryOffset,
    expanded = 0;
  const seen = new Set<string>();
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid office archive entry");
    const flags = data.readUInt16LE(offset + 8),
      method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20),
      uncompressed = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28),
      extraLength = data.readUInt16LE(offset + 30),
      commentLength = data.readUInt16LE(offset + 32),
      localOffset = data.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > end)
      throw new Error("Invalid office archive bounds");
    const externalMode = (data.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    if (externalMode === 0xa000)
      throw new Error("Office archive symlinks are not accepted");
    const name = data
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.startsWith("/") ||
      /^[a-z]:/i.test(name) ||
      name.split("/").includes("..") ||
      seen.has(name)
    )
      throw new Error("Unsafe office archive path");
    seen.add(name);
    if (
      flags & (1 | 64) ||
      ![0, 8].includes(method) ||
      uncompressed > MAX_ENTRY ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      uncompressed > Math.max(1024 * 1024, compressed * 200) ||
      expanded + uncompressed > MAX_EXPANDED
    )
      throw new Error("Office archive expansion exceeds processing limits");
    expanded += uncompressed;
    if (data.readUInt16LE(offset + 34) !== 0)
      throw new Error("Multipart office archive entry");
    assertExtraFields(data, offset + 46 + nameLength, extraLength);
    if (
      localOffset + 30 > directoryOffset ||
      data.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new Error("Invalid office archive local entry");
    const localNameLength = data.readUInt16LE(localOffset + 26),
      localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (
      start + compressed > directoryOffset ||
      data.readUInt16LE(localOffset + 8) !== method ||
      data.readUInt16LE(localOffset + 6) !== flags ||
      data
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .toString("utf8") !== name
    )
      throw new Error("Mismatched office archive entry");
    assertExtraFields(
      data,
      localOffset + 30 + localNameLength,
      localExtraLength,
    );
    const payload = data.subarray(start, start + compressed);
    const actual =
      method === 0
        ? payload
        : inflateRawSync(payload, {
            maxOutputLength: Math.min(MAX_ENTRY, uncompressed + 1),
          });
    if (actual.length !== uncompressed)
      throw new Error("Incorrect office archive expansion size");
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end)
    throw new Error("Unexpected office archive trailing directory");
}
