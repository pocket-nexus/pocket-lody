#!/usr/bin/env bun
// bun tools/build.ts (--host-config <pocket.host.config.ts> | --target <pocket.host.json>)
//                    [--out <lody.pocket>] [--stage WxH] [--layer <module>]...
//
// Compile the applet for one device with Pocket Shell's CLI (`pocket-shell
// compile`): the app contract is resolved against that device's host
// contract, which is what admits the package on it, and PocketJS's compiler
// writes the bundle. The project root is this repository: the applet imports
// PocketUI as @pocketjs/framework/ui and pocket-nexus/applets' network layer
// (vendor/applets/lib) by relative path, and an applet's imports stay inside
// its project root.
//
// --stage names the host's primary viewport. The manifest states the 3DS's
// and the RG DS Plus's; a host with another stage (the AYN Thor's 640x360)
// needs its own there to admit the package, though an applet draws on its
// touch surface only. --layer adds a product's system layer to the bundle
// (Omarchy Pocket's, which turns the pointer its shell sends as a contact
// back into the frame's pointer).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CACHE, POCKET_SHELL_CLI, ROOT } from "./paths.ts";

export { ROOT } from "./paths.ts";
const MANIFEST = resolve(ROOT, "pocket.app.json");

export interface BuildOptions {
  /** the device's host config, or */
  hostConfig?: string;
  /** its host contract */
  target?: string;
  out: string;
  stage?: [number, number];
  /** system layers a product adds */
  layers?: readonly string[];
  /** where intermediate files go */
  work?: string;
}

export interface Built {
  path: string;
  bytes: number;
  /** the bundle and its pack, for a simulator */
  js: string;
  pak: string;
}

export async function buildApplet(options: BuildOptions): Promise<Built> {
  if (!options.hostConfig && !options.target) throw new Error("pocket-lody: name the device: a host config or a host contract");
  const work = options.work ?? join(CACHE, "build", options.out.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  const contract = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (options.stage) contract.app.viewport.fixed.logical = [options.stage];
  // the manifest the compiler reads sits beside the real one, so its paths resolve the same way
  const manifest = join(dirname(MANIFEST), `.pocket.app.${options.stage ? options.stage.join("x") : "default"}.json`);
  writeFileSync(manifest, `${JSON.stringify(contract, null, 2)}\n`);
  const device = options.hostConfig ? ["--host-config", resolve(options.hostConfig)] : ["--target", resolve(options.target!)];
  const layers = (options.layers ?? []).flatMap((layer) => ["--layer", resolve(layer)]);
  const build = Bun.spawnSync(
    [process.execPath, POCKET_SHELL_CLI, "compile", "--manifest", manifest, "--project-root", ROOT, ...device, ...layers, "--outdir", join(work, "build"), "--plan-dir", join(work, "plan"), "--output", resolve(options.out)],
    // minified: PocketUI and the application are over the applet rules' 640 KiB of guest bundle otherwise
    { cwd: ROOT, env: { ...process.env, POCKETJS_MINIFY: process.env.POCKETJS_MINIFY ?? "1" }, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0 || !existsSync(options.out)) throw new Error(`pocket-lody: the applet did not compile\n${build.stdout}${build.stderr}`);
  const output = contract.app.output as string;
  return { path: resolve(options.out), bytes: statSync(options.out).size, js: join(work, "build", `${output}.js`), pak: join(work, "build", `${output}.pak`) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const layers = argv.flatMap((value, at) => (value === "--layer" && argv[at + 1] ? [argv[at + 1]!] : []));
  const hostConfig = opt("--host-config");
  const target = opt("--target");
  if (!hostConfig && !target) {
    console.error("usage: bun tools/build.ts (--host-config <pocket.host.config.ts> | --target <pocket.host.json>) [--out <lody.pocket>] [--stage WxH] [--layer <module>]...");
    process.exit(2);
  }
  const stage = opt("--stage")?.split("x").map(Number) as [number, number] | undefined;
  const built = await buildApplet({ hostConfig, target, out: opt("--out") ?? join(ROOT, "dist/lody.pocket"), stage, layers });
  console.log(`${built.path} ${(built.bytes / 1024).toFixed(0)} KiB`);
}
