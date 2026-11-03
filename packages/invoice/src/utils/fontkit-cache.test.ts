import { describe, expect, test } from "bun:test";
import { Font } from "@react-pdf/renderer";
import { getOwnedPdfFonts } from "./owned-fonts";

const faces = [
  ["regular", 0],
  ["bold", 1],
  ["italic", 2],
  ["bold italic", 3],
] as const;

describe("owned font composite glyph cache", () => {
  test.each(
    faces,
  )("%s keeps Unicode when a composite component later becomes text", async (_label, index) => {
    const registration = await getOwnedPdfFonts();
    const face = registration.fonts[index];
    if (!face) throw new Error("The reviewed font face is missing");
    // A private test family gives each face a fresh FontSource without
    // resetting the shared renderer store or invalidating another document.
    const descriptor = {
      fontFamily: `AGSaaS component cache regression ${index}`,
      fontWeight: face.fontWeight,
      fontStyle: face.fontStyle,
    };
    Font.register({ family: descriptor.fontFamily, ...face });
    await Font.load(descriptor);
    const font = Font.getFont(descriptor).data;
    if (!font || font.type !== "TTF")
      throw new Error("The regression requires the bundled TrueType font");

    // In all four pinned Liberation faces, Cyrillic Es is a composite of
    // Latin C. Encoding a PDF subset loads its component without characters.
    const cyrillic = font.glyphForCodePoint(0x421);
    expect(cyrillic.id).toBe(445);
    expect(cyrillic.codePoints).toEqual([0x421]);
    const firstSubset = font.createSubset();
    firstSubset.includeGlyph(cyrillic.id);
    expect(firstSubset.encode().byteLength).toBeGreaterThan(0);

    const component = font.getGlyph(38);
    expect(component.codePoints).toEqual([]);
    const originalPath = component.path.toSVG();
    const originalAdvance = component.advanceWidth;
    const latin = font.glyphForCodePoint(0x43);

    expect(latin.id).toBe(38);
    expect(latin.codePoints).toEqual([0x43]);
    expect(latin).not.toBe(component);
    expect(latin.path.toSVG()).toBe(originalPath);
    expect(latin.advanceWidth).toBe(originalAdvance);
    expect(latin.isMark).toBe(false);
    expect(latin.isLigature).toBe(false);
    // Existing layout/subset references keep their original metadata.
    expect(component.codePoints).toEqual([]);

    const secondSubset = font.createSubset();
    secondSubset.includeGlyph(latin.id);
    expect(secondSubset.encode().byteLength).toBeGreaterThan(0);
    // Populated cache entries retain their original identity and characters.
    expect(font.getGlyph(38)).toBe(latin);
    expect(font.glyphForCodePoint(0x43)).toBe(latin);
    expect(font.glyphForCodePoint(0x421)).toBe(cyrillic);
    expect(cyrillic.codePoints).toEqual([0x421]);
  });
});
