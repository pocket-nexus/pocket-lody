// pocket-lody/app/semantic.test.ts — the application names what things are,
// never how they look. This is what lets one source be drawn by every theme
// PocketUI has: a view that named a colour, an edge, a radius or a theme
// would be right in one of them and wrong in the rest.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const VIEWS = readdirSync(DIR).filter((file) => file.endsWith(".tsx"));

/** What only a theme may say. */
const PAINT: [RegExp, string][] = [
  [/#[0-9a-fA-F]{3,8}\b/, "a colour"],
  [/\b(background|pressedBackground|focusedBackground|borderColor|borderWidth|radius|shadow|opacity)=/, "a paint prop"],
  [/\bcolor=\{/, "a colour prop (say a tone)"],
  [/\.theme\.(color|face|metric|compact|traits|id|paint|glyph)\b/, "a read of the theme"],
  [/["'](pocket|classic|luna|aqua)["']/, "a theme by name"],
];

test("no view names a colour, an edge, a radius or a theme", () => {
  expect(VIEWS.length).toBeGreaterThan(5);
  const found: string[] = [];
  for (const file of VIEWS) {
    const lines = readFileSync(join(DIR, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith("//")) return;
      for (const [pattern, what] of PAINT) if (pattern.test(line)) found.push(`${file}:${index + 1} names ${what}: ${line.trim().slice(0, 80)}`);
    });
  }
  expect(found).toEqual([]);
});
