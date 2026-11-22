#!/usr/bin/env bun
// bun tools/thor.ts [build] [push] [open] [shot <name>] [log] [config <json>]
//                               [provision] [daemon] [restart] [call <METHOD> <path> [json]] [sh <command>]
//
// The loop on an AYN Thor (or a Retroid Pocket Duo Lite) over adb, for a
// device running a build of Omarchy Pocket that run-as reaches
// (`bun tools/android.ts apk --debuggable`):
//
//   build   compile the applet for the handheld's host contract, with Omarchy
//           Pocket's pointer layer (host/layers/pointer.ts)
//   push    put it in the Linux root's ~/.local/share/omarchy-pocket/applets,
//           which the shell reads before /usr/share
//   open    open it in a window (a window already open restarts)
//   shot    both displays as PNGs in .cache/shots/<name>-{up,low}.png
//   log     the daemon's last lines (log 80: that many), from Android's log
//   config  write the lody service's config.json in the root, and restart the
//           daemon so it is read: '{"driver":"remote","url":"http://127.0.0.1:4317","key":"…"}';
//           `config device` writes the one for a driver on the device itself:
//           {"driver":"cli","dataDir":"account","machineName":"<the device's model>"}
//   provision  put a Node the lody CLI runs on and the CLI in the service's
//           store in the root (services/lody/node, services/lody/lody-cli), so
//           the `cli` driver runs on the device with nothing on a computer.
//           The Node is nodejs.org's linux-arm64 build, checked against its
//           SHASUMS256.txt; the CLI is npm's `lody` with linux-arm64 addons
//   daemon  build omarchy-pocketd from this checkout, put it in the root in
//           place of the app's own and restart it (the app writes its own
//           again when it is updated)
//   restart restart omarchy-pocketd: the app starts it again when it exits
//   call    one request to the lody service through the daemon, as the applet
//           makes it: call GET '/sync?rev=-1', call POST /signin '{}'
//   sh      a command in the root
//
// ANDROID_SERIAL names the device when several are attached.
import { $ } from "bun";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildApplet } from "./build.ts";
import { CACHE, omarchy, ROOT } from "./paths.ts";

const PACKAGE = "dev.pocketnexus.omarchy";
const HANDHELD = process.env.POCKET_LODY_HANDHELD ?? "ayn-thor";
const OUT = join(CACHE, HANDHELD, "lody.pocket");
const SHOTS = join(CACHE, "shots");
const ROOTFS = "files/linux/rootfs";
const HOME = "/home/omarchy";
const APPLETS = `${HOME}/.local/share/omarchy-pocket/applets`;
const SERVICE = `${HOME}/.local/share/omarchy-pocket/companion/services/lody`;
const NODE_VERSION = process.env.POCKET_LODY_NODE ?? "v24.22.3";
const LODY_VERSION = process.env.POCKET_LODY_CLI ?? "0.113.1";
const adb = (...args: string[]) => $`adb ${args}`.quiet().nothrow();
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Ends omarchy-pocketd; the app's LinuxService starts it again. Answers
 *  when the shell has its bridge to the new one: a request made before that
 *  would be the bridge's first peer, which is where the daemon sends what
 *  is meant for the shell. */
async function restart() {
  await root("pkill -f /usr/lib/omarchy-pocket/omarchy-pocketd.js; true");
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    const up = await root("pgrep -f /usr/lib/omarchy-pocket/omarchy-pocketd.js >/dev/null && test -S $XDG_RUNTIME_DIR/omarchy-pocket/bridge.sock && omarchy-shell pocket.window list 2>/dev/null | head -n 1");
    if (/^\d/.test(up.split("\n").at(-1) ?? "")) return console.log("omarchy-pocketd restarted");
  }
  console.error("omarchy-pocketd did not come back with the shell on its bridge; open Omarchy Pocket on the device");
  process.exit(1);
}

/** A file of this computer at `path` in the root. */
async function put(file: string, path: string, mode = "644") {
  const tmp = `/data/local/tmp/pocket-lody-${Date.now()}`;
  await adb("push", file, tmp);
  const copied = await adb("shell", `run-as ${PACKAGE} sh -c 'mkdir -p ${ROOTFS}${path.slice(0, path.lastIndexOf("/"))} && cp ${tmp} ${ROOTFS}${path} && chmod ${mode} ${ROOTFS}${path}'`);
  await adb("shell", "rm", "-f", tmp);
  if (copied.exitCode !== 0) throw new Error(`${copied.stdout}${copied.stderr}`.trim() || `could not write ${path}`);
}

/** Node for linux-arm64 and the lody CLI with its linux-arm64 addons, as
 *  services/lody/{node,lody-cli} in the root (service/provider.ts locateCli
 *  finds them there). */
async function provision() {
  const stage = join(CACHE, "thor-stage");
  const name = `node-${NODE_VERSION}-linux-arm64`;
  const archive = join(stage, "dl", `${name}.tar.xz`);
  mkdirSync(join(stage, "dl"), { recursive: true });
  if (!existsSync(archive)) {
    console.log(`fetching ${name}`);
    await Bun.write(archive, await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.xz`));
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)).text();
  const wanted = new RegExp(`^([0-9a-f]{64})\\s+${name}\\.tar\\.xz$`, "m").exec(sums)?.[1];
  const got = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (!wanted || wanted !== got) {
    rmSync(archive, { force: true });
    throw new Error(`${name}.tar.xz does not match nodejs.org's SHASUMS256.txt`);
  }
  // the CLI's optional addons are per platform: ask npm for the device's
  const cli = join(stage, "lody-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "pocket-lody-cli-cache", private: true, dependencies: { lody: LODY_VERSION } }));
  const npm = Bun.which("npm") ?? (() => {
    const dir = join(CACHE, "node");
    const local = existsSync(dir) ? readdirSync(dir).map((entry) => join(dir, entry, "bin", "npm")).find((file) => existsSync(file)) : undefined;
    if (!local) throw new Error("npm is needed on this computer to fetch the lody CLI");
    return local;
  })();
  console.log(`installing lody@${LODY_VERSION} for linux-arm64`);
  await $`${npm} install --os=linux --cpu=arm64 --libc=glibc --no-audit --no-fund --loglevel=error`.cwd(cli).env({ ...process.env, PATH: `${join(npm, "..")}:${process.env.PATH ?? ""}` });
  const pkg = join(stage, "pkg");
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(join(pkg, "node"), { recursive: true });
  await $`tar -xJf ${archive} -C ${join(pkg, "node")} ${name}/bin/node ${name}/LICENSE`;
  mkdirSync(join(pkg, "lody-cli"));
  for (const entry of ["package.json", "package-lock.json", "node_modules"]) cpSync(join(cli, entry), join(pkg, "lody-cli", entry), { recursive: true });
  const prebuilds = join(pkg, "lody-cli/node_modules/better-sqlite3/prebuilds");
  if (existsSync(prebuilds)) for (const entry of readdirSync(prebuilds)) if (entry !== "linux-arm64.node") rmSync(join(prebuilds, entry), { recursive: true, force: true });
  const tgz = join(stage, "lody-thor.tgz");
  await $`tar --no-xattrs -czf ${tgz} -C ${pkg} .`.env({ ...process.env, COPYFILE_DISABLE: "1" });
  console.log(`pushing ${(Bun.file(tgz).size / 1024 / 1024).toFixed(0)} MiB`);
  await put(tgz, `${SERVICE}/lody-thor.tgz`);
  const node = `${SERVICE}/node/${name}/bin/node`;
  const out = await root(`cd ${SERVICE} && rm -rf node lody-cli && tar -xzf lody-thor.tgz 2>/dev/null; rm -f lody-thor.tgz; ${node} --version && ${node} lody-cli/node_modules/lody/dist/index.js --version`);
  console.log(out);
  if (!out.includes(LODY_VERSION)) throw new Error("the lody CLI did not run in the device's root");
  console.log(`provisioned: Node ${NODE_VERSION} and lody ${LODY_VERSION} in ${SERVICE}`);
}

/** A command in the app's Linux root, as tools/android.ts exec runs it. */
async function root(command: string): Promise<string> {
  const run = await $`bun ${join(omarchy(), "tools/android.ts")} exec ${command}`.cwd(omarchy()).quiet().nothrow();
  return `${run.stdout}${run.stderr}`.trim();
}

async function displays(): Promise<string[]> {
  const out = (await adb("shell", "dumpsys", "SurfaceFlinger", "--display-id")).stdout.toString();
  return [...out.matchAll(/Display (\d+)/g)].map((match) => match[1]!);
}

async function shot(name: string) {
  mkdirSync(SHOTS, { recursive: true });
  // AYN's burn-in refresher covers both displays every few minutes
  for (let i = 0; i < 20; i++) {
    const windows = (await adb("shell", "dumpsys", "window", "windows")).stdout.toString();
    if (!windows.includes("Burn-in Protection Refresher0")) break;
    await Bun.sleep(500);
  }
  const ids = await displays();
  const names = ["up", "low"];
  for (let i = 0; i < Math.min(2, ids.length); i++) {
    const png = (await $`adb exec-out screencap -p -d ${ids[i]}`.quiet()).stdout;
    const path = join(SHOTS, `${name}-${names[i]}.png`);
    writeFileSync(path, png);
    console.log(path);
  }
}

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "build": {
      const host = JSON.parse(await Bun.file(join(omarchy(), "android/handhelds", HANDHELD, "pocket.host.json")).text());
      // the handheld's host contract, and Omarchy Pocket's layer that hands its shell's resting pointer on as the frame's pointer
      const built = await buildApplet({ target: join(omarchy(), "android/handhelds", HANDHELD, "pocket.host.json"), out: OUT, stage: host.display.logicalViewports[0], layers: [join(omarchy(), "host/layers/pointer.ts")] });
      console.log(`built ${(built.bytes / 1024).toFixed(0)} KiB`);
      break;
    }
    case "push": {
      await adb("push", OUT, "/data/local/tmp/lody.pocket");
      const copied = await adb("shell", `run-as ${PACKAGE} sh -c 'mkdir -p ${ROOTFS}${APPLETS} && cp /data/local/tmp/lody.pocket ${ROOTFS}${APPLETS}/lody.pocket && ls -la ${ROOTFS}${APPLETS}/lody.pocket'`);
      console.log(`${copied.stdout}${copied.stderr}`.trim());
      break;
    }
    case "open":
      console.log(await root(`omarchy-shell pocket.window app ${APPLETS}/lody.pocket Lody applet`));
      break;
    case "shot":
      await shot(argv[++i] ?? "shot");
      break;
    case "log": {
      // omarchy-pocketd's lines are in Android's log, under its own tag
      const count = argv[i + 1] && /^\d+$/.test(argv[i + 1]!) ? argv[++i]! : "40";
      const lines = (await adb("logcat", "-d", "-s", "omarchy-pocketd", "-t", "2000")).stdout.toString().split("\n").filter((line) => line.includes("omarchy-pocketd"));
      console.log(lines.slice(-Number(count)).join("\n"));
      break;
    }
    case "config": {
      let json = argv[++i] ?? "{}";
      // the driver on the device itself, signed in as a machine named after the device
      if (json === "device") json = JSON.stringify({ driver: "cli", dataDir: "account", machineName: (await adb("shell", "getprop", "ro.product.model")).stdout.toString().trim() || "Pocket handheld" });
      JSON.parse(json);
      const dir = `${ROOTFS}${HOME}/.local/share/omarchy-pocket/companion/services/lody`;
      writeFileSync(join(CACHE, "config.json"), json);
      await adb("push", join(CACHE, "config.json"), "/data/local/tmp/lody-config.json");
      const wrote = await adb("shell", `run-as ${PACKAGE} sh -c 'mkdir -p ${dir} && cp /data/local/tmp/lody-config.json ${dir}/config.json && chmod 600 ${dir}/config.json'`);
      console.log(`${wrote.stdout}${wrote.stderr}`.trim() || "config written");
      await adb("shell", "rm", "-f", "/data/local/tmp/lody-config.json");
      await restart();
      break;
    }
    case "provision":
      await provision();
      break;
    case "daemon": {
      await $`bun ${join(omarchy(), "tools/build.ts")} daemon`.cwd(omarchy()).quiet();
      await put(join(omarchy(), ".cache/daemon/omarchy-pocketd.js"), "/usr/lib/omarchy-pocket/omarchy-pocketd.js");
      console.log("omarchy-pocketd.js replaced in the root");
      await restart();
      break;
    }
    case "restart":
      await restart();
      break;
    case "call": {
      const method = argv[++i] ?? "GET";
      const path = argv[++i] ?? "/sync?rev=-1";
      const body = argv[i + 1]?.startsWith("{") ? argv[++i]! : "";
      await put(join(ROOT, "tools/device-call.ts"), "/tmp/pocket-lody-call.ts");
      console.log(await root(`bun /tmp/pocket-lody-call.ts ${shellQuote(method)} ${shellQuote(path)} ${shellQuote(body)}`));
      break;
    }
    case "sh":
      console.log(await root(argv[++i] ?? "true"));
      break;
    default:
      console.error(`unknown step ${argv[i]}`);
      process.exit(2);
  }
}
