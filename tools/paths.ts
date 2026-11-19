// pocket-lody/tools/paths.ts — where things are, for the tools.
//
// This repository vendors what it is built from (vendor/pocketui,
// vendor/pocketjs, vendor/applets). It is itself vendored by Omarchy Pocket
// (vendor/pocket-lody), whose daemon carries the service and whose app
// carries the applet; there PocketJS is the checkout beside it, so a 300 MB
// submodule is not checked out twice.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** This repository. */
export const ROOT = resolve(import.meta.dir, "..");
/** What the tools keep between runs: builds, captures, a bridge's key. */
export const CACHE = join(ROOT, ".cache");

/** A dependency's checkout: this repository's vendor/<name>, or the one beside this repository where it is vendored among its own dependencies. `marker` is a file a checked-out one has. */
export function dep(name: string, marker: string): string {
  const named = process.env[`${name.toUpperCase().replace(/-/g, "_")}_ROOT`];
  for (const candidate of [named, join(ROOT, "vendor", name), resolve(ROOT, "..", name)]) {
    if (candidate && existsSync(join(candidate, marker))) return resolve(candidate);
  }
  throw new Error(`pocket-lody: no ${name} checkout: run \`git submodule update --init vendor/${name}\``);
}

export const pocketjs = () => dep("pocketjs", "tools/pocket.ts");

/** The Omarchy Pocket checkout the device tools build against: the one this repository is vendored in, or OMARCHY_POCKET. */
export function omarchy(): string {
  for (const candidate of [process.env.OMARCHY_POCKET, resolve(ROOT, "../..")]) {
    if (candidate && existsSync(join(candidate, "android/handhelds"))) return resolve(candidate);
  }
  throw new Error("pocket-lody: the device tools need an Omarchy Pocket checkout: run them from omarchy-pocket/vendor/pocket-lody, or set OMARCHY_POCKET");
}
