// pocket-lody/test/app.test.ts — the applet in PocketJS's simulator, on the
// surfaces of three kinds of device, against the service's own code on its
// fixture driver (tools/sim.ts). What a person would see is read back as the
// painted texts; what they would do is taps, drags and button presses.
//
// Needs the simulator's wasm core once: `bun vendor/pocket-shell/vendor/pocketjs/tools/wasm.ts`
// (rustup target wasm32-unknown-unknown). POCKET_LODY_SHOTS=<dir> writes PNGs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bootSim, buildGuest, fixtureServices, ROOT, type Guest, type Sim } from "../tools/sim.ts";

const SHOTS = process.env.POCKET_LODY_SHOTS;
let guest: Guest;
const open: { close(): void }[] = [];

beforeAll(async () => {
  guest = await buildGuest();
}, 240_000);

afterAll(() => {
  for (const services of open) services.close();
});

async function boot(size: [number, number] | null): Promise<Sim> {
  // no glyphs service: text outside ASCII shows as dots, the same on every computer
  // each boot is a new device: nothing kept from the one before (app/main.tsx keeps its state on the realm)
  delete (globalThis as { __pocketLody?: unknown }).__pocketLody;
  const services = await fixtureServices({ glyphs: false });
  open.push(services);
  const sim = await bootSim(guest, { size, globals: { __pocketWorkerChannels: services.bridge.channels }, busy: services.bridge.busy });
  await sim.run(90);
  return sim;
}
const shot = (sim: Sim, name: string) => SHOTS && sim.shot(join(SHOTS, `${name}.png`));
const has = (sim: Sim, text: string) => sim.texts().some((line) => line.includes(text));
const SESSION = "CI: flaky snapshot test on Linux";

describe("a 640 x 360 touch surface with a pad (a window on a handheld)", () => {
  test("list and detail side by side; a tap opens a session beside the list", async () => {
    const sim = await boot([640, 360]);
    expect(has(sim, "Lantern Labs")).toBe(true);
    expect(has(sim, "NEEDS YOU")).toBe(true);
    expect(has(sim, "No session open")).toBe(true);
    await sim.tap(100, 170);
    await sim.run(60);
    shot(sim, "split-session");
    // the list is still there, and the session's bar and transcript beside it
    expect(has(sim, "NEEDS YOU")).toBe(true);
    expect(has(sim, "Run under a French locale")).toBe(true);
    expect(has(sim, "Back")).toBe(false);
    expect(sim.texts()).toContain("Send");
  });

  test("typing, sending, and the agent's turn arriving", async () => {
    const sim = await boot([640, 360]);
    await sim.tap(100, 170);
    await sim.run(60);
    await sim.tap(380, 320);
    await sim.run(6);
    await sim.type("rerun under fr_FR");
    await sim.run(6);
    expect(has(sim, "rerun under fr_FR")).toBe(true);
    await sim.key("Enter");
    await sim.run(40);
    // the message is in the transcript and the session is working
    expect(sim.texts().filter((line) => line.includes("rerun under fr_FR")).length).toBe(1);
    expect(sim.texts()).toContain("Queue");
    await sim.run(60 * 9);
    shot(sim, "split-after-turn");
    expect(sim.texts()).toContain("Send");
    expect(sim.texts().some((line) => line.startsWith("Worked for"))).toBe(true);
  });

  test("a session dragged from the list onto the composer becomes a mention", async () => {
    const sim = await boot([640, 360]);
    await sim.tap(100, 170);
    await sim.run(60);
    await sim.lift(100, 80, 420, 320);
    await sim.run(20);
    shot(sim, "split-dropped");
    // the first row's title is Chinese: its mention shows as "@" and dots here
    expect(sim.texts().some((line) => line.startsWith("@"))).toBe(true);
  });

  test("the pad: focus moves by direction, the menu lists the commands, a session is carried to the composer", async () => {
    const sim = await boot([640, 360]);
    await sim.tap(100, 170);
    await sim.run(60);
    for (const button of ["DOWN", "DOWN", "DOWN"] as const) await sim.press(button);
    await sim.press("SQUARE");
    await sim.run(30);
    expect(has(sim, "COMMANDS")).toBe(true);
    expect(has(sim, "Mention in the Message")).toBe(true);
    await sim.press("DOWN");
    await sim.press("CIRCLE");
    await sim.run(30);
    expect(has(sim, "Drop here to mention it")).toBe(true);
    expect(sim.texts()).toContain("Drop");
    await sim.press("RIGHT");
    await sim.press("CIRCLE");
    await sim.run(30);
    shot(sim, "split-carried");
    expect(has(sim, "Drop here to mention it")).toBe(false);
    expect(sim.texts().some((line) => line.startsWith("@"))).toBe(true);
  });
});

describe("a 320 x 240 touch surface (a 3DS's lower screen)", () => {
  test("one pane at a time, with a way back in the bar", async () => {
    const sim = await boot([320, 240]);
    expect(has(sim, "NEEDS YOU")).toBe(true);
    expect(has(sim, "No session open")).toBe(false);
    await sim.tap(100, 150);
    await sim.run(60);
    shot(sim, "stack-session");
    expect(has(sim, "Back")).toBe(true);
    expect(has(sim, "NEEDS YOU")).toBe(false);
    await sim.tap(30, 12);
    await sim.run(40);
    expect(has(sim, "NEEDS YOU")).toBe(true);
  });

  test("a pan toward the list follows the contact and can be let go either way", async () => {
    const sim = await boot([320, 240]);
    await sim.tap(100, 150);
    await sim.run(60);
    // a short, slow pan back, let go: the session stays (a quick flick would complete it by its speed)
    await sim.drag(40, 120, 90, 120, 40);
    await sim.run(50);
    expect(has(sim, "Back")).toBe(true);
    // a long one: back at the list
    await sim.drag(40, 120, 260, 120, 10);
    await sim.run(50);
    shot(sim, "stack-swiped-back");
    expect(has(sim, "Back")).toBe(false);
    expect(has(sim, "NEEDS YOU")).toBe(true);
  });
});

describe("a 480 x 272 screen with buttons and no touch (a PSP)", () => {
  test("every step has a button: open, read the legend, the menu, back", async () => {
    const sim = await boot(null);
    expect(has(sim, "NEEDS YOU")).toBe(true);
    // the legend names the pad's buttons; there are no bar controls to tap
    expect(sim.texts()).toContain("Menu");
    expect(sim.texts()).not.toContain("...");
    for (const button of ["DOWN", "DOWN", "DOWN", "CIRCLE"] as const) await sim.press(button);
    await sim.run(60);
    shot(sim, "pad-session");
    expect(has(sim, "NEEDS YOU")).toBe(false);
    expect(sim.texts()).toContain("Back");
    await sim.press("SQUARE");
    await sim.run(30);
    expect(has(sim, "COMMANDS")).toBe(true);
    await sim.press("CROSS");
    await sim.run(30);
    expect(has(sim, "COMMANDS")).toBe(false);
    await sim.press("CROSS");
    await sim.run(40);
    expect(has(sim, "NEEDS YOU")).toBe(true);
  });
});

describe("themes: the same application painted by another tradition", () => {
  const app = () => (globalThis as { __pocketLody?: { setTheme(id: string): void; theme(): string } }).__pocketLody!;
  const run = (id: string) => (globalThis as { __pocketUI?: { commands: { run(id: string): boolean } } }).__pocketUI!.commands.run(id);

  test("changing theme keeps the open session, the draft and the list; only what frames them changes", async () => {
    const sim = await boot([640, 360]);
    await sim.tap(100, 170);
    await sim.run(60);
    await sim.tap(380, 320);
    await sim.run(6);
    await sim.type("half a thought");
    await sim.run(6);
    // the Pocket theme: commands in the pane's bar, no title bar, headings in capitals
    expect(has(sim, "NEEDS YOU")).toBe(true);
    expect(sim.texts()).not.toContain("Lody");
    expect(sim.texts()).not.toContain("View");
    for (const id of ["classic", "luna", "aqua", "pocket"]) {
      app().setTheme(id);
      await sim.run(20);
      shot(sim, `theme-${id}`);
      expect(has(sim, "half a thought")).toBe(true);
      expect(has(sim, "Run under a French locale")).toBe(true);
      expect(has(sim, SESSION.slice(0, 12))).toBe(true);
      expect(sim.texts()).toContain("Send");
    }
    // typing goes on where it was
    await sim.type(" finished");
    await sim.run(6);
    expect(has(sim, "half a thought finished")).toBe(true);
  });

  test("a title bar and a menu bar where the tradition has them, the same commands under either", async () => {
    const sim = await boot([640, 360]);
    app().setTheme("classic");
    await sim.run(20);
    // the frame's title, and a menu for each group the commands name
    expect(sim.texts()).toContain("Lody");
    expect(sim.texts()).toContain("View");
    expect(has(sim, "Needs you")).toBe(true);
    expect(has(sim, "NEEDS YOU")).toBe(false);
    // the View menu opens under its title and lists the commands that name it
    const view = sim.texts().indexOf("View");
    expect(view).toBeGreaterThanOrEqual(0);
    await sim.tap(120, 30);
    await sim.run(20);
    shot(sim, "theme-classic-menu");
    expect(sim.texts()).toContain("Refresh");
    expect(sim.texts()).toContain("Theme");
    await sim.press("CROSS");
    await sim.run(10);
    expect(sim.texts()).not.toContain("Refresh");
    // Aqua: a title bar, the commands in the toolbar, no menu bar
    app().setTheme("aqua");
    await sim.run(20);
    expect(sim.texts()).toContain("Lody");
    expect(sim.texts()).not.toContain("View");
    expect(sim.texts()).toContain("New");
  });

  test("the Theme command lists the themes and the choice is the one kept", async () => {
    const sim = await boot([640, 360]);
    expect(run("view.theme")).toBe(true);
    await sim.run(30);
    shot(sim, "theme-menu");
    for (const label of ["Pocket", "Classic 98", "XP", "Aqua"]) expect(sim.texts()).toContain(label);
    // the third row of the sheet
    const before = app().theme();
    await sim.press("DOWN");
    await sim.press("DOWN");
    await sim.press("DOWN");
    await sim.press("CIRCLE");
    await sim.run(30);
    expect(before).toBe("pocket");
    expect(app().theme()).toBe("luna");
    expect(sim.texts()).toContain("Lody");
  });
});

describe("text outside ASCII: the run-time faces, with a glyphs service", () => {
  interface TextStats {
    regular: { glyphs: number; requests: number; loads: number; evictions: number; failures: number };
    bold: { glyphs: number; requests: number; loads: number; evictions: number; failures: number };
    waitingFrames: number;
    relayouts: number;
  }
  const text = () => (globalThis as unknown as { __pocketUIText: { stats(): TextStats; settled(): boolean } }).__pocketUIText;
  const counts = () => {
    const stats = text().stats();
    return { requests: stats.regular.requests + stats.bold.requests, loads: stats.regular.loads + stats.bold.loads, glyphs: stats.regular.glyphs + stats.bold.glyphs, evictions: stats.regular.evictions + stats.bold.evictions, failures: stats.regular.failures + stats.bold.failures, waitingFrames: stats.waitingFrames, relayouts: stats.relayouts };
  };
  /** the stand-in glyphs service: a box for each character, the same on every computer (tools/glyphs-fake.ts) */
  async function bootWithGlyphs(size: [number, number]) {
    delete (globalThis as { __pocketLody?: unknown }).__pocketLody;
    const services = await fixtureServices({ glyphs: "fake" });
    open.push(services);
    const sim = await bootSim(guest, { size, globals: { __pocketWorkerChannels: services.bridge.channels }, busy: services.bridge.busy });
    await sim.run(90);
    return { sim, glyphs: services.fakeGlyphs! };
  }
  const select = (id: string) => (globalThis as unknown as { __pocketLody: { select(id: string): void } }).__pocketLody.select(id);
  const outside = (line: string) => [...line].map((ch) => ch.codePointAt(0)!).filter((cp) => cp >= 0x80);

  test("a line of Chinese and Latin is set by run: each script in its own face, no placeholder", async () => {
    const { sim, glyphs } = await bootWithGlyphs([640, 360]);
    await sim.tap(100, 80);
    await sim.run(60);
    shot(sim, "text-runs");
    // the session's title, "发布 0.9.0：等待确认推送 tag": the Chinese from the run-time face, the rest from the baked one beside it
    expect(sim.texts()).toContain("：等待确认推送");
    expect(sim.texts()).toContain(" tag");
    expect(sim.texts().some((line) => line.includes("\u00b7"))).toBe(false);
    expect(text().settled()).toBe(true);
    // only the characters shown were asked for, each once, and printable ASCII once for each weight
    expect(glyphs.log.repeats).toBe(0);
    expect(glyphs.log.glyphs).toBe(glyphs.log.asked);
    expect(counts().failures).toBe(0);
  });

  test("Chinese typed into the composer is drawn as it is typed, and sent as it was typed", async () => {
    const { sim, glyphs } = await bootWithGlyphs([640, 360]);
    await sim.tap(100, 170);
    await sim.run(60);
    await sim.tap(380, 320);
    await sim.run(6);
    await sim.type("重跑 fr_FR 的快照测试…");
    await sim.run(12);
    shot(sim, "text-composer");
    // the field is one face, character for character: the run-time one once anything is outside ASCII
    expect(sim.texts()).toContain("重跑 fr_FR 的快照测试…");
    for (const cp of outside("重跑的快照测试…")) expect(glyphs.sent(cp)).toBe(true);
    expect(text().settled()).toBe(true);
    await sim.key("Enter");
    await sim.run(40);
    // in the transcript it is a paragraph set by run
    expect(has(sim, "的快照测试…")).toBe(true);
    expect(sim.texts().some((line) => line.includes("\u00b7"))).toBe(false);
  });

  test("a long Chinese transcript scrolled up, down and up again: what was drawn once is never fetched, loaded or missing again", async () => {
    const { sim, glyphs } = await bootWithGlyphs([640, 360]);
    select("s-review");
    for (let i = 0; i < 300 && !(i > 4 && text().settled()); i++) await sim.run(1);
    await sim.run(20);
    expect(has(sim, "经有答案要好")).toBe(true);
    /** Drag until the transcript's first or last line is painted; at every stop, what is painted is whole. */
    const scroll = async (up: boolean, whole: boolean) => {
      for (let i = 0; i < 60; i++) {
        await sim.drag(420, up ? 70 : 240, 420, up ? 240 : 70, 8);
        await sim.run(6);
        const lines = sim.texts();
        expect(lines.some((line) => line.includes("\u00b7"))).toBe(false);
        if (whole) {
          // every character on screen has its glyph: nothing waits, and nothing held was dropped
          expect(text().settled()).toBe(true);
          for (const line of lines) for (const cp of outside(line)) expect(glyphs.sent(cp)).toBe(true);
        }
        if (lines.some((line) => line.includes(up ? "下午的设计评审" : "经有答案要好"))) return;
      }
      throw new Error(`the transcript's ${up ? "start" : "end"} was not reached`);
    };
    // the first time up, older pages arrive and bring characters with them
    await scroll(true, false);
    for (let i = 0; i < 300 && !text().settled(); i++) await sim.run(1);
    shot(sim, "text-review-top");
    const seen = counts();
    expect(seen.glyphs).toBeGreaterThan(700);
    expect(seen.failures).toBe(0);
    // from here on everything has been drawn once
    await scroll(false, true);
    await scroll(true, true);
    await scroll(false, true);
    await scroll(true, true);
    shot(sim, "text-review-again");
    expect(counts()).toEqual(seen);
    expect(seen.evictions).toBe(0);
    expect(glyphs.log.repeats).toBe(0);
  }, 120_000);
});
