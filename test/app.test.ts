// pocket-lody/test/app.test.ts — the applet in PocketJS's simulator, on the
// surfaces of three kinds of device, against the service's own code on its
// fixture driver (tools/sim.ts). What a person would see is read back as the
// painted texts; what they would do is taps, drags and button presses.
//
// Needs the simulator's wasm core once: `bun vendor/pocketjs/tools/wasm.ts`
// (rustup target wasm32-unknown-unknown). POCKET_LODY_SHOTS=<dir> writes PNGs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bootSim, buildGuest, fixtureServices, ROOT, type Sim } from "../tools/sim.ts";

const SHOTS = process.env.POCKET_LODY_SHOTS;
let guest = "";
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
    for (const button of ["DOWN", "DOWN", "DOWN"]) await sim.press(button);
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
    for (const button of ["DOWN", "DOWN", "DOWN", "CIRCLE"]) await sim.press(button);
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
