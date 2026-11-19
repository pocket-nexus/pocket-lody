// The companion provider: which driver a config picks, and that a broken one
// is an answer, not a crash.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResponse, SyncResponse } from "../protocol.ts";
import { createLodyProvider, loadConfig, locateCli, type LodyProvider } from "./provider.ts";
import { LODY_VERSION, NODE_VERSION, setupTarget, type SetupDeps } from "./setup.ts";

const decoder = new TextDecoder();
let dir = "";
let provider: LodyProvider | undefined;
const logged: string[] = [];

function store(config?: unknown, where: "service" | "root" = "service") {
  dir = mkdtempSync(join(tmpdir(), "pocket-lody-provider-"));
  if (config !== undefined) {
    const target = where === "service" ? join(dir, "services", "lody") : dir;
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  logged.length = 0;
  provider = createLodyProvider({ storeDir: dir, log: (line) => logged.push(line) });
  return provider;
}

afterEach(() => {
  provider?.close();
  provider = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function sync(): Promise<SyncResponse> {
  const response = await provider!.handle({ method: "GET", path: "/sync", query: new URLSearchParams("rev=0"), body: new Uint8Array(0), maxBytes: 4 * 1024 * 1024, signal: new AbortController().signal });
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toBe("application/json");
  return JSON.parse(decoder.decode(response.body)) as SyncResponse;
}

describe("the lody provider", () => {
  test("is the companion's shape and starts nothing until asked", async () => {
    store({ driver: "fixture" });
    expect(provider!.name).toBe("lody");
    expect(await provider!.state()).toEqual({ started: false });
    expect(logged).toEqual([]);
    const { snapshot } = await sync();
    expect(snapshot!.link).toMatchObject({ phase: "ready", driver: "fixture" });
    expect(logged).toEqual(["lody: fixture driver"]);
    expect(await provider!.state()).toEqual({ started: true, driver: "fixture", phase: "ready" });
  });

  test("the fixture's time can be fixed for a screenshot", async () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    store({ driver: "fixture", now }, "root");
    const { snapshot } = await sync();
    expect(Math.max(...snapshot!.sessions.map((row) => row.updatedAt))).toBeLessThanOrEqual(now + 60_000);
    expect(Math.max(...snapshot!.sessions.map((row) => row.updatedAt))).toBeGreaterThan(now - 60_000);
  });

  test("a config that cannot be read is an unavailable link that names the file", async () => {
    store("{ not json");
    const { snapshot } = await sync();
    expect(snapshot!.link.phase).toBe("unavailable");
    expect(snapshot!.link.detail).toContain(join(dir, "services", "lody", "config.json"));
    expect(snapshot!.link.detail).toContain("Fix or remove it.");
    expect(snapshot!.sessions).toEqual([]);
    const response = await provider!.handle({ method: "POST", path: "/send", query: new URLSearchParams(), body: new TextEncoder().encode(JSON.stringify({ session: "s", text: "hi" })) });
    expect(response.status).toBe(409);
    expect((JSON.parse(decoder.decode(response.body)) as ActionResponse).error).toContain("Fix or remove it.");
  });

  test("an unknown driver, a remote without an address, a CLI that is not there", async () => {
    store({ driver: "telepathy" });
    expect((await sync()).snapshot!.link).toMatchObject({ phase: "unavailable" });
    expect((await sync()).snapshot!.link.detail).toContain('it is "fixture", "cli" or "remote"');
    provider!.close();
    rmSync(dir, { recursive: true, force: true });

    store({ driver: "remote" });
    expect((await sync()).snapshot!.link).toEqual({ phase: "unavailable", driver: "remote", detail: 'The bridge\'s config needs "url": the address of the computer running serve.ts, like http://192.168.1.20:4317.' });
    provider!.close();
    rmSync(dir, { recursive: true, force: true });

    store({ driver: "cli", node: "/no/such/node", cli: "/no/such/lody.js" });
    const { link } = (await sync()).snapshot!;
    expect(link).toEqual({ phase: "unavailable", driver: "cli", detail: 'Node is not at /no/such/node; fix "node" in the bridge\'s config.' });
  });

  test("a remote whose bridge is down is unavailable, not an error", async () => {
    store({ driver: "remote", url: "http://127.0.0.1:9", key: "some-key-here" });
    const { snapshot } = await sync();
    expect(snapshot!.link).toMatchObject({ phase: "unavailable", driver: "remote", via: "127.0.0.1:9" });
  });
});

describe("finding the CLI", () => {
  test("a config is read from the service's own directory first, then the store's", () => {
    store({ driver: "fixture" }, "root");
    expect(loadConfig(dir)).toEqual({ config: { driver: "fixture" } });
    mkdirSync(join(dir, "services", "lody"), { recursive: true });
    writeFileSync(join(dir, "services", "lody", "config.json"), JSON.stringify({ driver: "remote", url: "http://10.0.0.2:4317" }));
    expect(loadConfig(dir).config).toEqual({ driver: "remote", url: "http://10.0.0.2:4317" });
    expect(loadConfig(join(dir, "nowhere"))).toEqual({ config: {} });
  });

  test("what is missing is said: no CLI, or a Node the CLI does not run on", () => {
    dir = mkdtempSync(join(tmpdir(), "pocket-lody-provider-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const node = join(bin, "node");
    writeFileSync(node, "#!/bin/sh\necho v20.11.0\n");
    chmodSync(node, 0o755);
    const old = locateCli({ cli: "/somewhere/lody/dist/index.js" }, { env: { PATH: bin }, storeDir: join(dir, "store"), cache: false });
    expect(old).toEqual({ missing: 'The lody CLI needs Node 22.23.4+, 24.22.1+ or 26.12.1+; this computer\'s is v20.11.0. Install one and set "node" in the bridge\'s config.' });
    const none = locateCli({}, { env: { PATH: bin }, storeDir: join(dir, "store"), cache: false });
    expect(none).toEqual({ missing: 'The lody CLI is not installed on this computer. Install it (npm install -g lody) or set "cli" in the bridge\'s config.' });
    writeFileSync(node, "#!/bin/sh\necho v24.22.3\n");
    writeFileSync(join(bin, "lody"), "#!/usr/bin/env node\n");
    const found = locateCli({}, { env: { PATH: bin }, storeDir: join(dir, "store"), cache: false });
    expect(found).toMatchObject({ node });
    expect((found as { cli: string[] }).cli[0]).toEndWith("/bin/lody");
    // a Node and a CLI kept in the service's own store are found too
    const kept = join(dir, "store", "services", "lody");
    mkdirSync(join(kept, "node", "node-v24.22.3", "bin"), { recursive: true });
    mkdirSync(join(kept, "lody-cli", "node_modules", "lody", "dist"), { recursive: true });
    writeFileSync(join(kept, "node", "node-v24.22.3", "bin", "node"), "#!/bin/sh\necho v24.22.3\n");
    chmodSync(join(kept, "node", "node-v24.22.3", "bin", "node"), 0o755);
    writeFileSync(join(kept, "lody-cli", "node_modules", "lody", "dist", "index.js"), "");
    expect(locateCli({}, { env: { PATH: "" }, storeDir: join(dir, "store"), cache: false })).toEqual({ node: join(kept, "node", "node-v24.22.3", "bin", "node"), cli: [join(kept, "lody-cli", "node_modules", "lody", "dist", "index.js")] });
  });
});

describe("setting up on a device", () => {
  const NODE = `node-${NODE_VERSION}-linux-arm64`;
  const ran: string[][] = [];

  /** A device whose network gives `bytes` for Node and whose npm "installs" the CLI. */
  function device(options: { bytes?: Uint8Array; npm?: number; config?: unknown } = {}) {
    dir = mkdtempSync(join(tmpdir(), "pocket-lody-setup-"));
    const service = join(dir, "services", "lody");
    mkdirSync(service, { recursive: true });
    if (options.config !== undefined) writeFileSync(join(service, "config.json"), JSON.stringify(options.config));
    ran.length = 0;
    logged.length = 0;
    const deps: SetupDeps = {
      platform: "linux",
      arch: "arm64",
      async download(_url, progress) {
        const bytes = options.bytes ?? new Uint8Array(3 * 1024 * 1024);
        progress(bytes.length, bytes.length);
        return bytes;
      },
      async run(command, args, run) {
        ran.push([command.split("/").at(-1)!, ...args.map((arg) => arg.split("/").at(-1)!)]);
        if (args.some((arg) => arg.endsWith("npm-cli.js"))) {
          if (options.npm) return { code: options.npm, output: "npm error network request failed\n" };
          mkdirSync(join(run.cwd!, "node_modules", "lody", "dist"), { recursive: true });
          writeFileSync(join(run.cwd!, "node_modules", "lody", "dist", "index.js"), "");
          writeFileSync(join(run.cwd!, "node_modules", "lody", "package.json"), JSON.stringify({ version: LODY_VERSION }));
        }
        return { code: 0, output: "" };
      },
    };
    provider = createLodyProvider({ storeDir: dir, log: (line) => logged.push(line), setup: deps, locate: { cache: false, env: { PATH: "", OMARCHY_POCKET_HANDHELD: "ayn-thor" } } });
    return service;
  }

  /** A Node already in the store, as a first run that was interrupted leaves it. */
  function nodeInStore(service: string) {
    mkdirSync(join(service, "node", NODE, "bin"), { recursive: true });
    writeFileSync(join(service, "node", NODE, "bin", "node"), "");
    mkdirSync(join(service, "node", NODE, "lib", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(service, "node", NODE, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "");
  }

  const post = async (path: string) => {
    const response = await provider!.handle({ method: "POST", path, query: new URLSearchParams(), body: new TextEncoder().encode("{}"), maxBytes: 4 * 1024 * 1024, signal: new AbortController().signal });
    return JSON.parse(decoder.decode(response.body)) as ActionResponse;
  };
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const { link } = (await sync()).snapshot!;
      if (link.setup?.state !== "running") return link;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("setup did not settle");
  };

  test("only a Linux device is offered it", () => {
    expect(setupTarget("linux", "arm64")).toBe("linux-arm64");
    expect(setupTarget("linux", "x64")).toBe("linux-x64");
    expect(setupTarget("darwin", "arm64")).toBeUndefined();
    expect(setupTarget("linux", "riscv64")).toBeUndefined();
  });

  test("a device with nothing chosen shows sample data and offers to set up", async () => {
    device();
    const { snapshot } = await sync();
    expect(snapshot!.link).toMatchObject({ phase: "ready", driver: "fixture", setup: { state: "needed" } });
    expect(snapshot!.sessions.length).toBeGreaterThan(0);
  });

  test("setup installs the CLI with the store's Node, writes the device's config and leaves it signed out", async () => {
    const service = device();
    nodeInStore(service);
    expect(await post("/setup")).toEqual({ ok: true });
    const link = await settled();
    expect(link).toEqual({ phase: "signed-out", driver: "cli", via: "AYN Thor", machine: "AYN Thor", ownAccount: true, detail: "AYN Thor is not signed in to Lody. Sign in to see your sessions." });
    expect(ran).toEqual([
      ["node", "npm-cli.js", "install", "--no-audit", "--no-fund", "--loglevel=error", "--cache", "npm-cache"],
      ["node", "index.js", "--version"],
    ]);
    expect(JSON.parse(readFileSync(join(service, "config.json"), "utf8"))).toEqual({ driver: "cli", dataDir: "account", machineName: "AYN Thor" });
    expect((await sync()).snapshot!.sessions).toEqual([]);
    // nothing is left to set up
    expect(await post("/setup")).toEqual({ ok: true });
    expect(ran).toHaveLength(2);
  });

  test("a Node that is not the pinned build is not installed, and setup can be tried again", async () => {
    const service = device({ config: { driver: "cli" } });
    expect((await sync()).snapshot!.link).toMatchObject({ phase: "unavailable", driver: "cli", detail: "The Lody CLI is not on this device yet. Set it up to sign in.", setup: { state: "needed" } });
    expect(await post("/setup")).toEqual({ ok: true });
    const link = await settled();
    expect(link.setup).toEqual({ state: "failed", step: "The Node that was downloaded is not the one expected, so it was not installed. Try again." });
    expect(ran).toEqual([]);
    expect(existsSync(join(service, "node"))).toBe(false);
    expect(existsSync(join(service, "setup"))).toBe(false);
    expect(await post("/setup")).toEqual({ ok: true });
    expect((await settled()).setup?.state).toBe("failed");
  });

  test("an npm that fails says why", async () => {
    const service = device({ npm: 1 });
    nodeInStore(service);
    await post("/setup");
    const link = await settled();
    expect(link).toMatchObject({ driver: "fixture", setup: { state: "failed", step: "The Lody CLI could not be installed (npm exit 1): npm error network request failed. Check the network and try again." } });
  });

  test("a bridge with nothing to set up says so", async () => {
    store({ driver: "fixture" });
    const response = await provider!.handle({ method: "POST", path: "/setup", query: new URLSearchParams(), body: new TextEncoder().encode("{}"), maxBytes: 4 * 1024 * 1024, signal: new AbortController().signal });
    expect(JSON.parse(decoder.decode(response.body))).toMatchObject({ ok: false, error: "This bridge has nothing to set up." });
  });
});
