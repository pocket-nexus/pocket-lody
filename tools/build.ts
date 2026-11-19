#!/usr/bin/env bun
// bun tools/build.ts --host-config <pocket.host.config.ts> [--out <lody.pocket>] [--stage WxH]
//
// Compile the applet for one device: `pocket compile` against that device's
// host contract, which is what admits the package on it (a package runs on
// the profile it was compiled for). The project root is this repository: the
// applet imports PocketUI (vendor/pocketui) and pocket-nexus/applets' network
// layer (vendor/applets/lib) by relative path, and an applet's imports stay
// inside its project root.
//
// --stage names the host's primary viewport. The manifest states the 3DS's
// and the RG DS Plus's; a host with another stage (the AYN Thor's 640x360)
// needs its own there to admit the package, though an applet draws on its
// touch surface only.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CACHE, pocketjs, ROOT } from "./paths.ts";

export { ROOT } from "./paths.ts";
const MANIFEST = resolve(ROOT, "pocket.app.json");

export interface BuildOptions {
  hostConfig: string;
  out: string;
  stage?: [number, number];
  /** where intermediate files go */
  work?: string;
}

export async function buildApplet(options: BuildOptions): Promise<{ path: string; bytes: number }> {
  const VENDOR = pocketjs();
  const work = options.work ?? join(CACHE, "build", options.out.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(options.out), { recursive: true });
  const contract = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (options.stage) contract.app.viewport.fixed.logical = [options.stage];
  // the manifest the compiler reads sits beside the real one, so its paths resolve the same way
  const manifest = join(dirname(MANIFEST), `.pocket.app.${options.stage ? options.stage.join("x") : "default"}.json`);
  writeFileSync(manifest, `${JSON.stringify(contract, null, 2)}\n`);
  const build = Bun.spawnSync(
    [process.execPath, join(VENDOR, "tools/pocket.ts"), "compile", "--manifest", manifest, "--project-root", ROOT, "--host-config", resolve(options.hostConfig), "--outdir", join(work, "build"), "--plan-dir", join(work, "plan"), "--output", resolve(options.out)],
    { cwd: ROOT, // minified: PocketUI and the application are over the applet rules' 640 KiB of guest bundle otherwise
    env: { ...process.env, POCKETJS_FRAMEWORK_ROOT: VENDOR, POCKETJS_MINIFY: process.env.POCKETJS_MINIFY ?? "1" }, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0 || !existsSync(options.out)) throw new Error(`pocket-lody: the applet did not compile\n${build.stdout}${build.stderr}`);
  return { path: resolve(options.out), bytes: statSync(options.out).size };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const hostConfig = opt("--host-config");
  if (!hostConfig) {
    console.error("usage: bun tools/build.ts --host-config <pocket.host.config.ts> [--out <lody.pocket>] [--stage WxH]");
    process.exit(2);
  }
  const stage = opt("--stage")?.split("x").map(Number) as [number, number] | undefined;
  const built = await buildApplet({ hostConfig, out: opt("--out") ?? join(ROOT, "dist/lody.pocket"), stage });
  console.log(`${built.path} ${(built.bytes / 1024).toFixed(0)} KiB`);
}
