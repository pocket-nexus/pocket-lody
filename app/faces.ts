// pocket-lody/app/faces.ts — text in any script. PocketUI draws ASCII from
// the faces baked into the package and asks a resolver about anything else
// (pocketui/src/ui/textview.ts setFaceResolver). This resolver is
// pocket-nexus/applets' glyph client: it asks the companion's glyphs service
// for an atlas holding the characters on screen and loads it into font slot
// 21 (regular) or 22 (bold). Until an atlas covers a text, the text shows
// with "·" in place of what cannot be drawn yet, and is laid out again when
// the atlas loads.
import { createGlyphs, GLYPH_BOLD, GLYPH_TEXT, richText } from "../vendor/applets/ui/glyphs.ts";
import { forgetMeasures, RICH_BOLD_FACE, RICH_FACE, setFaceResolver, type Face } from "../vendor/pocketui/src/index.ts";

export function installFaces(): void {
  const text = createGlyphs(GLYPH_TEXT);
  const bold = createGlyphs(GLYPH_BOLD);
  let seen = -1;
  setFaceResolver({
    revision() {
      const revision = text.revision() + bold.revision();
      if (revision !== seen) {
        // an atlas loaded: widths measured in its slot before are stale
        seen = revision;
        forgetMeasures(RICH_FACE.slot);
        forgetMeasures(RICH_BOLD_FACE.slot);
      }
      return revision;
    },
    resolve(source: string, face: Face) {
      const glyphs = face.bold ? bold : text;
      const rich = richText(source);
      glyphs.want([rich]);
      if (glyphs.covers(rich)) return { face: { ...(face.bold ? RICH_BOLD_FACE : RICH_FACE), line: Math.max(face.line, RICH_FACE.line) }, text: rich, pending: false };
      return { face, text: rich.replace(/[^\x20-\x7e\n]/g, "·").replace(/·+/g, (run) => (run.length > 3 ? "···" : run)), pending: glyphs.pending(rich) };
    },
  });
}
