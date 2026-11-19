#!/usr/bin/env bun
// bun tools/sim.ts [--size WxH | --psp] [--theme pocket|classic|luna|aqua] [--start setup|signed-out] [--do "<steps>"] [--shot out.png]
//
// The applet in PocketJS's simulator, headless, on one surface: `--size` is a
// touch surface of that many points (default 640x360), `--psp` a 480x272
// screen with buttons and no touch. The steps are PocketUI's simulator
// runner's (vendor/pocketui/tools/sim.ts: frames, tap, drag, lift, press,
// type, key, shot, texts, cmd, theme); what this adds is the companion's
// services, in process: `lody` on its fixture driver, a `store` in memory,
// and Pocket Hub's `glyphs` where this computer can draw them.
//
// --theme starts in a theme (as if it were the one kept from last time);
// --start begins where a device without an account does (service/fixture.ts).
import { join } from "node:path";
import { bootSim, buildGuest as buildWith, runSteps, type Sim, type SimOptions } from "../vendor/pocketui/tools/sim.ts";
import { CACHE, dep, pocketjs, ROOT } from "./paths.ts";

export { bootSim, runSteps, ROOT, type Sim, type SimOptions };

/** The applet (or another manifest in this repository) built for the simulator. */
export const buildGuest = (manifestPath: string = join(ROOT, "pocket.app.json")): Promise<string> => buildWith(manifestPath, { root: ROOT, pocketjs: pocketjs(), out: join(CACHE, "sim") });

/** The companion's services for a simulated applet: `lody` on its fixture driver (its clock moves a frame at a time), a `store` in memory, and Pocket Hub's `glyphs` where this computer can draw them. */
export async function fixtureServices(options: { glyphs?: boolean; remembered?: Record<string, unknown>; start?: "setup" | "signed-out" } = {}) {
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
  if (options.glyphs !== false) {
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
        if (!glyphs) return json(503, { error: "this computer cannot draw glyphs" });
        const answer = await glyphs.handle({ method: request.method, path: request.url.pathname.replace(/^\/glyphs/, ""), query: request.url.searchParams, body: request.body, maxBytes: 256 * 1024, console: { id: "sim" }, signal: new AbortController().signal });
        return { status: answer.status, headers: answer.headers, body: answer.body };
      },
    },
    () => backend.advance(1000 / 60),
  );
  return { bridge, backend, service, close: () => { service.close(); glyphs?.close?.(); } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const started = performance.now();
  const guest = await buildGuest();
  const size = argv.includes("--psp") ? null : ((opt("--size") ?? "640x360").split("x").map(Number) as [number, number]);
  const services = argv.includes("--no-service") ? null : await fixtureServices({ glyphs: !argv.includes("--no-glyphs"), remembered: opt("--theme") ? { theme: opt("--theme") } : undefined, start: opt("--start") as "setup" | "signed-out" | undefined });
  const sim = await bootSim(guest, { size, globals: services ? { __pocketWorkerChannels: services.bridge.channels } : {}, busy: services?.bridge.busy });
  await sim.run(30);
  for (const line of sim.logs()) console.log(line);
  await runSteps(sim, opt("--do") ?? "");
  const shot = opt("--shot");
  if (shot) sim.shot(shot);
  if (argv.includes("--net")) for (const line of services?.bridge.log ?? []) console.log(line);
  console.log(`done in ${Math.round(performance.now() - started)} ms`);
  services?.close();
  process.exit(0);
}
