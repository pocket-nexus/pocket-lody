// pocket-lody/app/faces.ts — text in any script. PocketUI draws ASCII from
// the faces baked into the package and everything else from its run-time
// faces (pocketui/src/ui/runtimetext.ts): two tables of glyphs, regular and
// bold, that grow by the characters shown and keep them. What this file adds
// is the way to the glyphs: the companion's `glyphs` service (omarchy-pocketd
// on Omarchy Pocket, Pocket Hub on a paired Mac), asked through the applet's
// worker for an atlas of the characters a request names; and the characters
// of what the workspace just sent, asked for before they are scrolled to.
import { createRenderEffect, type Accessor } from "solid-js";
import { platform } from "@pocketjs/framework/platform";
import { companionService, DESCRIPTOR_BYTES, fetch, NET_MAX_RESPONSE_BYTES, requestBytes } from "../vendor/applets/lib/net.ts";
import { installRuntimeText, type GlyphRequest, type RuntimeText } from "../vendor/pocketui/src/index.ts";

const URL = companionService("glyphs", "/atlas");
/** One reply: a few hundred glyphs at the device's density, up to what one response carries here. */
const MAX_BYTES = Math.min(NET_MAX_RESPONSE_BYTES, 4 * 1024 * 1024);
const REQUEST = { method: "POST", headers: { "content-type": "application/json" }, maxBytes: MAX_BYTES, timeoutMs: 20_000 } as const;
const body = (request: GlyphRequest): string => JSON.stringify({ px: request.px, bold: request.bold, slot: request.slot, density: request.density, text: request.text, ascii: request.ascii });
/** What a request's descriptor has left for the characters it names (vendor/applets/lib/net.ts): the rest is the URL, the headers and the other fields. A quote or a backslash among them is written with escapes, hence the margin. */
const TEXT_BYTES = DESCRIPTOR_BYTES - requestBytes(URL, { ...REQUEST, body: body({ px: 99, bold: false, slot: 99, density: 9, text: "", ascii: false }) }) - 24;

let installed: RuntimeText | null = null;

/** The run-time faces over the companion's glyphs service. Before the tree is mounted. */
export function installFaces(): RuntimeText {
  installed ??= installRuntimeText({
    density: platform.pixelRatio,
    // A device that takes megabyte responses has the memory for the everyday
    // set of Chinese and Japanese in each weight; a smaller one keeps a
    // thousand glyphs, the ones named most recently.
    capacity: NET_MAX_RESPONSE_BYTES > 256 * 1024 ? 4096 : 1024,
    transport: {
      textBytes: TEXT_BYTES,
      responseBytes: MAX_BYTES,
      async atlas(request) {
        const response = await fetch(URL, { ...REQUEST, body: body(request) });
        if (!response.ok) throw new Error(`glyphs: HTTP ${response.status}`);
        return await response.bytes();
      },
    },
  });
  return installed;
}

/** The strings of a value, however it is shaped. */
function strings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) strings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const key in value) strings((value as Record<string, unknown>)[key], out);
  }
}

/** Ask for the characters of what the workspace holds as it arrives: the
 *  rows of the session list, the items of the open transcript. They are
 *  fetched behind anything on screen, so a transcript read from its end is
 *  whole by the time it is scrolled up. An item is read once: one that is
 *  still being written is a new object each time it grows. */
export function prefetchText(text: RuntimeText, sources: readonly Accessor<readonly object[] | undefined>[]): void {
  if (!text.available) return;
  const read = new WeakSet<object>();
  const found: string[] = [];
  for (const source of sources) {
    createRenderEffect(() => {
      found.length = 0;
      for (const item of source() ?? []) {
        if (read.has(item)) continue;
        read.add(item);
        strings(item, found);
      }
      if (found.length > 0) text.prefetch(found);
    });
  }
}
