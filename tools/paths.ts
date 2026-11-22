// pocket-lody/tools/paths.ts — where things are, for the tools.
//
// This repository vendors what it is built from: Pocket Shell
// (vendor/pocket-shell: the applet contract, its compiler front end, the
// Runtime's guest modules) with the PocketJS it pins
// (vendor/pocket-shell/vendor/pocketjs: the framework, PocketUI as
// @pocketjs/framework/ui, the compiler and the simulator), and
// pocket-nexus/applets for its network layer (vendor/applets/lib). It is
// itself vendored by Omarchy Pocket (vendor/pocket-lody), whose daemon
// carries the service and whose app carries the applet.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** This repository. */
export const ROOT = resolve(import.meta.dir, "..");
/** What the tools keep between runs: builds, captures, a bridge's key. */
export const CACHE = join(ROOT, ".cache");

/** pocket-nexus/pocket-shell: vendor/pocket-shell, or the checkout POCKET_SHELL_ROOT names. */
export const POCKET_SHELL = process.env.POCKET_SHELL_ROOT ? resolve(process.env.POCKET_SHELL_ROOT) : join(ROOT, "vendor/pocket-shell");
/** The PocketJS Pocket Shell pins. */
export const POCKETJS = join(POCKET_SHELL, "vendor/pocketjs");
/** Pocket Shell's CLI: `compile` of an app contract into a .pocket. */
export const POCKET_SHELL_CLI = join(POCKET_SHELL, "cli/pocket-shell.ts");
/** pocket-nexus/applets: the network layer (lib/). */
export const APPLETS = join(ROOT, "vendor/applets");

/** A checkout beside this repository's, or the one `<NAME>_ROOT` names (pocket-hub, for the simulator's glyphs). `marker` is a file a checked-out one has. */
export function dep(name: string, marker: string): string {
  const named = process.env[`${name.toUpperCase().replace(/-/g, "_")}_ROOT`];
  for (const candidate of [named, join(ROOT, "vendor", name), resolve(ROOT, "..", name)]) {
    if (candidate && existsSync(join(candidate, marker))) return resolve(candidate);
  }
  throw new Error(`pocket-lody: no ${name} checkout: name one in ${name.toUpperCase().replace(/-/g, "_")}_ROOT`);
}

/** The Omarchy Pocket checkout the device tools build against: the one this repository is vendored in, or OMARCHY_POCKET. */
export function omarchy(): string {
  for (const candidate of [process.env.OMARCHY_POCKET, resolve(ROOT, "../..")]) {
    if (candidate && existsSync(join(candidate, "android/handhelds"))) return resolve(candidate);
  }
  throw new Error("pocket-lody: the device tools need an Omarchy Pocket checkout: run them from omarchy-pocket/vendor/pocket-lody, or set OMARCHY_POCKET");
}
