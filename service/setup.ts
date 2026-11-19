// pocket-lody/service/setup.ts — putting the lody CLI and a Node it runs on
// in the service's store, from the device itself.
//
// A handheld that runs the `cli` driver needs two things no Linux root
// carries: Node 24.22.1 or later, and the npm package `lody`. This fetches
// both where the provider looks for them (provider.ts locateCli):
//
//   <store>/services/lody/node/node-<version>-linux-<arch>/bin/node
//   <store>/services/lody/lody-cli/node_modules/lody/dist/index.js
//
// Node is nodejs.org's build for the device's architecture, and is run only
// when its SHA-256 is the one pinned here. The CLI is installed by that
// Node's own npm, which picks the CLI's native addons for the device. About
// 90 MB comes over the network and 500 MB is written; it is done once.
//
// Nothing here reads or writes a sign-in: that is `lody login`, afterwards.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NODE_VERSION = "v24.22.3";
/** nodejs.org/dist/v24.22.3/SHASUMS256.txt */
const NODE_SHA256: Record<string, string> = {
  "linux-arm64": "6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c",
  "linux-x64": "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb",
};
export const LODY_VERSION = "0.113.1";

export interface SetupDeps {
  platform: string;
  arch: string;
  /** the bytes at `url`; `progress` hears how many of how many have come */
  download(url: string, progress: (got: number, total: number) => void): Promise<Uint8Array>;
  /** a command to its end: its exit code and the tail of what it printed */
  run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs: number }): Promise<{ code: number; output: string }>;
}

/** The build of Node this device takes, or undefined where setup is a computer's own job. */
export function setupTarget(platform: string, arch: string): string | undefined {
  if (platform !== "linux") return undefined;
  const target = arch === "arm64" ? "linux-arm64" : arch === "x64" ? "linux-x64" : undefined;
  return target && NODE_SHA256[target] ? target : undefined;
}

export class SetupError extends Error {}

const MB = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

/** Fetches and installs both; `step` hears a sentence for each stage. Throws a
 *  SetupError whose message a person can act on. Safe to run again: a stage
 *  that finished is not repeated, and one that did not is started over. */
export async function installCli(dir: string, deps: SetupDeps, step: (text: string) => void): Promise<{ node: string; cli: string }> {
  const target = setupTarget(deps.platform, deps.arch);
  if (!target) throw new SetupError("This device's kind is not one the Lody CLI can be set up on from here; install Node 24 and `npm install lody` on it yourself.");
  const name = `node-${NODE_VERSION}-${target}`;
  const nodeDir = join(dir, "node");
  const node = join(nodeDir, name, "bin", "node");
  const cliDir = join(dir, "lody-cli");
  const cli = join(cliDir, "node_modules", "lody", "dist", "index.js");
  const work = join(dir, "setup");
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    if (!existsSync(node)) {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      step("Downloading Node…");
      let said = -1;
      let bytes: Uint8Array;
      try {
        bytes = await deps.download(`https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.xz`, (got, total) => {
          const now = MB(got);
          if (now === said) return;
          said = now;
          step(total > 0 ? `Downloading Node (${now} of ${MB(total)} MB)…` : `Downloading Node (${now} MB)…`);
        });
      } catch (error) {
        throw new SetupError(`Node could not be downloaded from nodejs.org: ${(error as Error).message}. Check the network and try again.`);
      }
      if (createHash("sha256").update(bytes).digest("hex") !== NODE_SHA256[target]) throw new SetupError("The Node that was downloaded is not the one expected, so it was not installed. Try again.");
      const archive = join(work, `${name}.tar.xz`);
      writeFileSync(archive, bytes);
      step("Unpacking Node…");
      const unpacked = await deps.run("tar", ["-xJf", archive, "-C", work], { timeoutMs: 5 * 60_000 });
      if (unpacked.code !== 0 || !existsSync(join(work, name, "bin", "node"))) throw new SetupError(`Node could not be unpacked (tar exit ${unpacked.code}). This device needs tar and xz.`);
      rmSync(archive, { force: true });
      mkdirSync(nodeDir, { recursive: true });
      rmSync(join(nodeDir, name), { recursive: true, force: true });
      renameSync(join(work, name), join(nodeDir, name));
    }

    if (!existsSync(cli) || installedVersion(cliDir) !== LODY_VERSION) {
      step("Installing the Lody CLI…");
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cliDir, "package.json"), JSON.stringify({ name: "pocket-lody-cli", private: true, dependencies: { lody: LODY_VERSION } }));
      const bin = join(nodeDir, name, "bin");
      const npm = join(nodeDir, name, "lib", "node_modules", "npm", "bin", "npm-cli.js");
      if (!existsSync(npm)) throw new SetupError("The Node in the store has no npm with it; remove the store's node directory and set up again.");
      const installed = await deps.run(node, [npm, "install", "--no-audit", "--no-fund", "--loglevel=error", "--cache", join(work, "npm-cache")], {
        cwd: cliDir,
        env: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: work, npm_config_update_notifier: "false" },
        timeoutMs: 15 * 60_000,
      });
      if (installed.code !== 0 || !existsSync(cli)) throw new SetupError(`The Lody CLI could not be installed (npm exit ${installed.code}): ${lastLine(installed.output) || "no reason given"}. Check the network and try again.`);
    }

    step("Checking the Lody CLI…");
    const checked = await deps.run(node, [cli, "--version"], { timeoutMs: 60_000 });
    if (checked.code !== 0) throw new SetupError(`The Lody CLI was installed but does not run on this device: ${lastLine(checked.output) || `exit ${checked.code}`}.`);
    return { node, cli };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function installedVersion(cliDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(cliDir, "node_modules", "lody", "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

const lastLine = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? "";

/** The network and the processes of this computer. */
export const systemDeps = (): SetupDeps => ({
  platform: process.platform,
  arch: process.arch,
  async download(url, progress) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`the server answered ${response.status}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    const parts: Uint8Array[] = [];
    let got = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      progress(got, total);
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  },
  run(command, args, options) {
    return new Promise((resolve) => {
      let output = "";
      let child;
      try {
        child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ code: 127, output: (error as Error).message });
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
      const hear = (chunk: string) => (output = (output + chunk).slice(-4096));
      child.stdout!.setEncoding("utf8").on("data", hear);
      child.stderr!.setEncoding("utf8").on("data", hear);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: 127, output: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
    });
  },
});
