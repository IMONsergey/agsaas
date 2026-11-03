const FONT_FAMILY = "Liberation Sans";

export async function getOwnedPdfFonts() {
  const [regular, bold, italic, boldItalic] = await Promise.all([
    import("../fonts/liberation-regular"),
    import("../fonts/liberation-bold"),
    import("../fonts/liberation-italic"),
    import("../fonts/liberation-bolditalic"),
  ]);
  return {
    family: FONT_FAMILY,
    fonts: [
      {
        src: `data:font/ttf;base64,${regular.fontBase64}`,
        fontWeight: 400,
        fontStyle: "normal" as const,
      },
      {
        src: `data:font/ttf;base64,${bold.fontBase64}`,
        fontWeight: 700,
        fontStyle: "normal" as const,
      },
      {
        src: `data:font/ttf;base64,${italic.fontBase64}`,
        fontWeight: 400,
        fontStyle: "italic" as const,
      },
      {
        src: `data:font/ttf;base64,${boldItalic.fontBase64}`,
        fontWeight: 700,
        fontStyle: "italic" as const,
      },
    ],
  };
}

type OwnedOgFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: "normal" | "italic";
};
let ogFonts: Promise<OwnedOgFont[]> | undefined;

/** The renderer receives bundled bytes; no font URL is resolved at request time. */
export function getOwnedOgFonts() {
  ogFonts ??= getOwnedPdfFonts().then(({ family, fonts }) =>
    fonts.map((face) => {
      const binary = atob(face.src.slice(face.src.indexOf(",") + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return {
        name: family,
        data: bytes.buffer,
        weight: face.fontWeight as 400 | 700,
        style: face.fontStyle,
      };
    }),
  );
  return ogFonts;
}
