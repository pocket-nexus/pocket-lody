#!/usr/bin/env bun
// bun tools/sim.ts [--size WxH | --psp] [--theme pocket|classic|luna|aqua] [--start setup|signed-out] [--no-glyphs | --fake-glyphs] [--text-stats] [--do "<steps>"] [--shot out.png]
//
// The applet on PocketJS's simulation host, headless, on one surface:
// `--size` is a touch surface of that many points (default 640x360), `--psp`
// a 480x272 screen with buttons and no touch. The applet is compiled as for
// the 3DS (Pocket Shell's devices/3ds host contract); the steps are
// PocketJS's tools/pocketui-sim.ts runner's (frames, tap, drag, lift, press,
// type, key, hover, click, wheel, shot, texts, cmd, theme). What this adds is
// the companion's services, in process: `lody` on its fixture driver, a
// `store` in memory, and Pocket Hub's `glyphs` where this computer can draw
// them (--fake-glyphs: a stand-in that draws a box for each character, the
// same everywhere, and --text-stats prints what the run-time faces asked for
// and loaded).
//
// --theme starts in a theme (as if it were the one kept from last time);
// --start begins where a device without an account does (service/fixture.ts).
import { join } from "node:path";
import { buildApplet } from "./build.ts";
import { CACHE, dep, POCKET_SHELL, POCKETJS, ROOT } from "./paths.ts";

const runner = (await import(join(POCKETJS, "tools/pocketui-sim.ts"))) as typeof import("../vendor/pocket-shell/vendor/pocketjs/tools/pocketui-sim.ts");
export const { runSteps } = runner;
export type Sim = import("../vendor/pocket-shell/vendor/pocketjs/tools/pocketui-sim.ts").Sim;
export type SimOptions = import("../vendor/pocket-shell/vendor/pocketjs/tools/pocketui-sim.ts").SimOptions;
export { ROOT };

/** The applet's bundle and pack, compiled as for the 3DS. */
export interface Guest {
  js: string;
  pak: string;
}

/** The applet built for the simulator. */
export async function buildGuest(): Promise<Guest> {
  const built = await buildApplet({ target: join(POCKET_SHELL, "devices/3ds/pocket.host.json"), out: join(CACHE, "sim/lody.pocket"), work: join(CACHE, "sim") });
  return { js: built.js, pak: built.pak };
}

/** Boot a built applet on a touch surface of `size` points, or (null) a PSP's 480x272 screen with buttons and no touch. */
export function bootSim(guest: Guest, options: SimOptions & { size: [number, number] | null }): Promise<Sim> {
  const { size, ...rest } = options;
  return runner.bootSim(
    size ? { ...guest, viewport: { width: 400, height: 240, rasterDensity: 1, auxiliary: size }, surface: "auxiliary" } : { ...guest, viewport: { width: 480, height: 272, rasterDensity: 1 }, surface: "primary" },
    rest,
  );
}

/** The companion's services for a simulated applet: `lody` on its fixture driver (its clock moves a frame at a time), a `store` in memory, and `glyphs`: Pocket Hub's where this computer can draw them, `"fake"` for the stand-in that is the same on every computer (tools/glyphs-fake.ts), `false` for none. */
export async function fixtureServices(options: { glyphs?: boolean | "fake"; remembered?: Record<string, unknown>; start?: "setup" | "signed-out" } = {}) {
  const { createBridge } = await import("./bridge.ts");
  const { createLodyService } = await import("../service/service.ts");
  const { createFixtureBackend } = await import("../service/fixture.ts");
  const backend = createFixtureBackend({ now: Date.UTC(2026, 10, 18, 14, 0, 0), start: options.start, machine: options.start ? "AYN Thor" : undefined });
  const service = createLodyService(backend, { now: () => backend.now() });
  const store = new Map<string, string>();
  // what the applet "kept from last time" (app/state.ts): the theme it starts in
  if (options.remembered) store.set("lody.state", JSON.stringify(options.remembered));
  const json = (status: number, value: unknown) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  let glyphs: { handle(request: unknown): Promise<{ status: number; headers?: Record<string, string>; body?: Uint8Array }>; close?(): void } | null = null;
  const fake = options.glyphs === "fake" ? (await import("./glyphs-fake.ts")).createFakeGlyphs() : null;
  if (options.glyphs !== false && !fake) {
    try {
      const { createGlyphsService } = await import(join(dep("pocket-hub", "tools/companion/services/glyphs.ts"), "tools/companion/services/glyphs.ts"));
      glyphs = createGlyphsService({ storeDir: join(CACHE, "sim/glyphs"), log: () => {} });
    } catch (error) {
      console.error(`sim: no glyphs service on this computer (${error instanceof Error ? error.message.split("\n")[0] : error})`);
    }
  }
  const bridge = createBridge(
    {
      lody: async (request) => {
        const answer = await service.handle({ method: request.method, path: request.url.pathname.replace(/^\/lody/, "") || "/", query: request.url.searchParams, body: request.body });
        return { status: answer.status, headers: answer.headers, body: answer.body };
      },
      store: (request) => {
        const name = request.url.searchParams.get("name") ?? "";
        if (request.url.pathname === "/store/get") return json(200, { value: store.has(name) ? JSON.parse(store.get(name)!) : null });
        if (request.url.pathname === "/store/set") return store.set(name, new TextDecoder().decode(request.body)), json(200, { ok: true });
        return json(404, { error: "no such store call" });
      },
      glyphs: async (request) => {
        if (fake) return fake.handle(request);
        if (!glyphs) return json(503, { error: "this computer cannot draw glyphs" });
        const answer = await glyphs.handle({ method: request.method, path: request.url.pathname.replace(/^\/glyphs/, ""), query: request.url.searchParams, body: request.body, maxBytes: 256 * 1024, console: { id: "sim" }, signal: new AbortController().signal });
        return { status: answer.status, headers: answer.headers, body: answer.body };
      },
    },
    () => backend.advance(1000 / 60),
  );
  return { bridge, backend, service, fakeGlyphs: fake, close: () => { service.close(); glyphs?.close?.(); } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const started = performance.now();
  const guest = await buildGuest();
  const size = argv.includes("--psp") ? null : ((opt("--size") ?? "640x360").split("x").map(Number) as [number, number]);
  const services = argv.includes("--no-service") ? null : await fixtureServices({ glyphs: argv.includes("--fake-glyphs") ? "fake" : !argv.includes("--no-glyphs"), remembered: opt("--theme") ? { theme: opt("--theme") } : undefined, start: opt("--start") as "setup" | "signed-out" | undefined });
  const sim = await bootSim(guest, { size, globals: services ? { __pocketWorkerChannels: services.bridge.channels } : {}, busy: services?.bridge.busy });
  await sim.run(30);
  for (const line of sim.logs()) console.log(line);
  await runSteps(sim, opt("--do") ?? "");
  const shot = opt("--shot");
  if (shot) sim.shot(shot);
  if (argv.includes("--text-stats")) console.log(JSON.stringify({ faces: (globalThis as { __pocketUIText?: { stats(): unknown } }).__pocketUIText?.stats(), service: services?.fakeGlyphs?.log }, null, 2));
  if (argv.includes("--net")) for (const line of services?.bridge.log ?? []) console.log(line);
  console.log(`done in ${Math.round(performance.now() - started)} ms`);
  services?.close();
  process.exit(0);
}
