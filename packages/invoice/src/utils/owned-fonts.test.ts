import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import manifest from "../fonts/manifest.json";
import { getOwnedOgFonts, getOwnedPdfFonts } from "./owned-fonts";

describe("owned document font distribution", () => {
  test("all four embedded font files match the reviewed source hashes", async () => {
    const faces = await getOwnedPdfFonts();
    expect(faces.family).toBe("Liberation Sans");
    expect(faces.fonts).toHaveLength(4);
    for (const [index, face] of faces.fonts.entries()) {
      expect(face.src.startsWith("data:font/ttf;base64,")).toBe(true);
      const bytes = Buffer.from(face.src.split(",")[1]!, "base64");
      expect(bytes.byteLength).toBe(manifest.files[index]!.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        manifest.files[index]!.sha256,
      );
    }
  });
  test("OG uses the exact bundled regular face instead of a font URL", async () => {
    const fonts = await getOwnedOgFonts();
    expect(fonts).toHaveLength(4);
    const [font] = fonts;
    expect(font?.name).toBe("Liberation Sans");
    expect(
      createHash("sha256").update(new Uint8Array(font!.data)).digest("hex"),
    ).toBe(manifest.files[0]!.sha256);
  });
});
