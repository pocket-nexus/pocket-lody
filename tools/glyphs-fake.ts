// tools/glyphs-fake.ts — a stand-in for the companion's `glyphs` service, for
// the simulator's tests: it answers POST /glyphs/atlas as the real ones do
// (a FONT ATLAS v3 of the characters asked for, at the size and density asked
// for), with a drawn box in place of each glyph, the same on every computer,
// and it counts what it was asked. Printable ASCII is half an em wide and
// everything else one em, as in the fonts a device has.
import { encodeAtlas, type AtlasGlyph } from "../vendor/pocketui/src/core/glyphfont.ts";
import type { BridgeAnswer, BridgeRequest } from "./bridge.ts";

export interface GlyphLog {
  requests: number;
  /** glyphs sent, and the characters the requests named */
  glyphs: number;
  asked: number;
  /** bytes of the replies */
  bytes: number;
  /** the largest reply */
  largest: number;
  /** requests that asked for a character an earlier request had been answered with, by face */
  repeats: number;
}

export interface FakeGlyphs {
  handle(request: BridgeRequest): BridgeAnswer;
  log: GlyphLog;
  /** whether a reply has carried this character, in either weight */
  sent(cp: number): boolean;
}

const ASCII = Array.from({ length: 0x7f - 0x20 }, (_, index) => 0x20 + index);

export function createFakeGlyphs(): FakeGlyphs {
  const log: GlyphLog = { requests: 0, glyphs: 0, asked: 0, bytes: 0, largest: 0, repeats: 0 };
  const sent = new Map<string, Set<number>>();
  const fake: FakeGlyphs = {
    log,
    sent: (cp) => [...sent.values()].some((face) => face.has(cp)),
    handle(request) {
      if (request.method !== "POST" || !request.url.pathname.endsWith("/atlas")) return { status: 404, body: "no such glyphs call" };
      let body: { px?: number; bold?: boolean; slot?: number; density?: number; text?: string; ascii?: boolean };
      try {
        body = JSON.parse(new TextDecoder().decode(request.body));
      } catch {
        return { status: 400, body: "not JSON" };
      }
      const px = body.px ?? 13;
      const density = body.density ?? 1;
      const named = [...(body.text ?? "")].map((ch) => ch.codePointAt(0)!);
      const cps = [...new Set([...(body.ascii === false ? [] : ASCII), ...named])].filter((cp) => cp >= 0x20);
      const face = `${body.slot}/${px}/${body.bold ? "b" : "r"}`;
      const before = sent.get(face) ?? new Set<number>();
      sent.set(face, before);
      if (named.some((cp) => before.has(cp))) log.repeats++;
      for (const cp of cps) before.add(cp);
      const cellW = px;
      const cellH = Math.ceil(px * 1.4);
      const w = cellW * density;
      const h = cellH * density;
      const glyphs: AtlasGlyph[] = cps.map((cp) => {
        const advance = cp < 0x80 ? Math.round(px * 0.55) : px;
        const cell = new Uint8Array(w * h);
        // a box of the glyph's width on the baseline, with a notch that differs by character
        if (cp !== 0x20) {
          const right = (advance - 1) * density;
          const top = Math.round(h * (cp < 0x80 ? 0.4 : 0.2));
          const bottom = Math.round(h * 0.8);
          for (let y = top; y < bottom; y++) for (let x = density; x < right; x++) cell[y * w + x] = (x + y * (1 + (cp % 3))) % (4 * density) < density ? 90 : 255;
        }
        return { cp, advance, xoff: 0, cell };
      });
      const atlas = encodeAtlas({ slot: body.slot ?? 21, bold: body.bold === true, cellW, cellH, baseline: Math.round(px * 1.1), lineHeight: cellH, density, glyphs });
      log.requests++;
      log.asked += named.length;
      log.glyphs += glyphs.length;
      log.bytes += atlas.length;
      if (atlas.length > log.largest) log.largest = atlas.length;
      return { status: 200, headers: { "content-type": "application/octet-stream" }, body: atlas };
    },
  };
  return fake;
}
