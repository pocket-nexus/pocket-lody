#!/usr/bin/env bun
// bun tools/text-bench.ts [--size WxH]
//
// What text outside ASCII costs, counted in the simulator on the fixture's
// long Chinese transcript (service/fixture-data.ts `review`) against the
// stand-in glyphs service (tools/glyphs-fake.ts): the requests and bytes a
// screen of new text takes, the frames until it is whole, the layouts glyph
// arrivals cause, the native text nodes on screen, and what scrolling back
// over text already seen costs (nothing: that is the point). Then the
// per-frame and per-paragraph costs of the faces themselves, timed here.
//
// The simulator draws at density 1; a device's bytes are the same glyph
// counts at its own density (the table at the end).
import { encodeAtlas, GlyphTable, parseAtlas, splitRuns } from "../vendor/pocketui/src/core/glyphfont.ts";
import { createRuntimeFaces } from "../vendor/pocketui/src/core/runtimefaces.ts";
import { REVIEW_ROUNDS } from "../service/fixture-data.ts";
import { bootSim, buildGuest, fixtureServices } from "./sim.ts";

interface Stats {
  regular: { glyphs: number; requests: number; asked: number; replyBytes: number; loads: number; loadMs: number; atlasBytes: number; evictions: number };
  bold: { glyphs: number; requests: number; asked: number; replyBytes: number; loads: number; loadMs: number; atlasBytes: number; evictions: number };
  waitingFrames: number;
  layouts: number;
  relayouts: number;
}
const text = () => (globalThis as unknown as { __pocketUIText: { stats(): Stats; settled(): boolean } }).__pocketUIText;
const flat = (s: Stats) => ({ requests: s.regular.requests + s.bold.requests, glyphs: s.regular.asked + s.bold.asked, bytes: s.regular.replyBytes + s.bold.replyBytes, loads: s.regular.loads + s.bold.loads, waitingFrames: s.waitingFrames, layouts: s.layouts, relayouts: s.relayouts });
const delta = (a: ReturnType<typeof flat>, b: ReturnType<typeof flat>) => Object.fromEntries(Object.entries(b).map(([key, value]) => [key, value - a[key as keyof typeof a]]));

const argv = process.argv.slice(2);
const size = ((argv[argv.indexOf("--size") + 1] && argv.includes("--size") ? argv[argv.indexOf("--size") + 1]! : "640x360").split("x").map(Number)) as [number, number];
const guest = await buildGuest();
const services = await fixtureServices({ glyphs: "fake" });
const sim = await bootSim(guest, { size, globals: { __pocketWorkerChannels: services.bridge.channels }, busy: services.bridge.busy });
await sim.run(90);
const rows: Record<string, unknown>[] = [];
let last = flat(text().stats());
const mark = (step: string, more: Record<string, unknown> = {}) => {
  const now = flat(text().stats());
  rows.push({ step, ...delta(last, now), ...more });
  last = now;
};
rows.push({ step: "start: the list, ASCII in both faces", ...last });

// a screen of Chinese nobody has drawn yet
(globalThis as unknown as { __pocketLody: { select(id: string): void } }).__pocketLody.select("s-review");
let frames = 0;
do {
  await sim.run(1);
  frames++;
} while (frames < 4 || (!text().settled() && frames < 600));
mark("open the transcript at its end", { framesUntilWhole: frames, textNodes: sim.texts().length });
await sim.run(30);

const x = Math.round(size[0] * 0.66);
const [high, low] = [Math.round(size[1] * 0.2), Math.round(size[1] * 0.66)];
const scroll = async (up: boolean) => {
  for (let i = 0; i < 60; i++) {
    await sim.drag(x, up ? high : low, x, up ? low : high, 8);
    await sim.run(6);
    const seen = sim.texts();
    if (seen.some((line) => line.includes(up ? "下午的设计评审" : "经有答案要好"))) return i + 1;
  }
  return -1;
};
for (const pass of ["first", "second", "third"]) {
  const up = await scroll(true);
  mark(`${pass} time up to the start`, { drags: up, textNodes: sim.texts().length });
  const down = await scroll(false);
  mark(`${pass} time down to the end`, { drags: down, textNodes: sim.texts().length });
}
console.table(rows);
const end = text().stats();
console.log(`held: ${end.regular.glyphs} regular + ${end.bold.glyphs} bold glyphs; evictions ${end.regular.evictions + end.bold.evictions}; service asked again for a character it had sent: ${services.fakeGlyphs!.log.repeats} times`);
console.log(`loads: ${end.regular.loads + end.bold.loads}, ${(end.regular.loadMs + end.bold.loadMs).toFixed(2)} ms in all (wasm core, density 1, atlas ${end.regular.atlasBytes} bytes)`);
services.close();

// --- the faces themselves, timed here --------------------------------------------
const time = (run: () => void, times: number): number => {
  const started = performance.now();
  for (let i = 0; i < times; i++) run();
  return (performance.now() - started) / times;
};
const cps = [...new Set(REVIEW_ROUNDS.flat().join(""))].map((ch) => ch.codePointAt(0)!).filter((cp) => cp >= 0x80);
const cell = (density: number) => ({ cellW: 13, cellH: 17, density, bytes: 13 * density * 17 * density });
const table = (count: number, density: number): GlyphTable => {
  const made = new GlyphTable(13, 8192);
  const { cellW, cellH, bytes } = cell(density);
  const glyphs = Array.from({ length: count }, (_, i) => ({ cp: 0x4e00 + i, advance: 13, xoff: 0, cell: new Uint8Array(bytes).fill(1) }));
  made.add(parseAtlas(encodeAtlas({ slot: 21, cellW, cellH, baseline: 14, lineHeight: 17, density, glyphs }))!);
  return made;
};
const faces = createRuntimeFaces({ transport: { atlas: () => new Promise(() => {}) }, density: 3, regular: { slot: 21, size: 13, line: 18 }, bold: { slot: 22, size: 13, line: 18, bold: true }, load() {}, onRevision() {}, onEpoch() {} });
faces.tick();
const paragraph = REVIEW_ROUNDS[4]![1];
const held = table(4096, 1);
held.add(parseAtlas(encodeAtlas({ slot: 21, cellW: 13, cellH: 17, baseline: 14, lineHeight: 17, density: 1, glyphs: cps.map((cp) => ({ cp, advance: 13, xoff: 0, cell: new Uint8Array(13 * 17) })) }))!);
const micro = [
  { what: "a frame with nothing to do (tick)", ms: time(() => faces.tick(), 2_000_000) },
  { what: `a ${[...paragraph].length}-character paragraph split into runs`, ms: time(() => void splitRuns(paragraph), 20_000) },
  { what: "the same paragraph checked against a face that holds it (want)", ms: time(() => void held.missing([paragraph]), 20_000) },
  { what: "the same paragraph measured from the table", ms: time(() => void held.measure(paragraph), 20_000) },
  ...[1, 2, 3].flatMap((density) => [800, 4096].map((count) => {
    const made = table(count, density);
    return { what: `write out a face of ${count} glyphs at density ${density} (${(made.build(21, false)!.length / 1048576).toFixed(1)} MB)`, ms: time(() => void made.build(21, false), 20) };
  })),
];
console.table(micro.map((row) => ({ what: row.what, "µs": Math.round(row.ms * 1000 * 100) / 100 })));
console.table([1, 2, 3].map((density) => ({ density, "bytes a glyph (13 x 17 cell)": 8 + cell(density).bytes, "a 230-glyph reply, KB": Math.round((230 * (8 + cell(density).bytes)) / 1024), "a face of 4096, MB": Math.round(((4096 * (8 + cell(density).bytes)) / 1048576) * 10) / 10 })));
process.exit(0);
