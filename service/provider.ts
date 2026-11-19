// pocket-lody/service/provider.ts — the `lody` service as a companion
// provider: `https://companion.pocket/lody/<path>` from the applet.
//
// The provider's shape is the companion's ServiceProvider
// (vendor/pocket-hub/tools/companion/services.ts), matched structurally:
// nothing is imported from vendor/ or daemon/, so this directory stands on
// its own. The daemon registers it as
//
//   SERVICE_FACTORIES.lody = (context) => createLodyProvider(context);
//
// The driver is picked by `<storeDir>/services/lody/config.json` (or
// `<storeDir>/config.json`):
//
//   {"driver": "cli", "node": "/path/to/node", "cli": "/path/to/lody/dist/index.js", "workspace": "my-team"}
//   {"driver": "remote", "url": "http://192.168.1.20:4317", "key": "…"}
//   {"driver": "fixture"}
//
// With no config: `cli` when a lody CLI and a Node it runs on are found on
// this computer, else `fixture`. A driver that is missing or broken is not a
// crash: every request is answered, and `Link.phase` is "unavailable" with a
// `detail` that says what to fix.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Changes, OK, unavailableBackend, type LodyBackend } from "./backend.ts";
import { createCliBackend, type CliConfig } from "./cli.ts";
import { nodeRunsLody } from "./cli-map.ts";
import { createFixtureBackend } from "./fixture.ts";
import { createRemoteBackend } from "./remote.ts";
import { createLodyService, type LodyService } from "./service.ts";
import { installCli, setupTarget, SetupError, systemDeps, type SetupDeps } from "./setup.ts";
import type { Link } from "../protocol.ts";

// --- the companion's shapes, as much of them as this provider uses ------------

export interface ProviderContext {
  /** the companion's store directory */
  storeDir: string;
  log: (line: string) => void;
  /** the network and processes setup uses; default: this computer's */
  setup?: SetupDeps;
  /** where a CLI is looked for besides the store, for tests: `cache` false
   *  leaves out a development checkout's own, `env` stands for the process's */
  locate?: { cache?: boolean; env?: NodeJS.ProcessEnv };
}

export interface ProviderRequest {
  method: string;
  /** the path after the service's name, from "/" */
  path: string;
  query: URLSearchParams;
  body: Uint8Array;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface LodyProvider {
  readonly name: "lody";
  handle(request: ProviderRequest): Promise<ProviderResponse>;
  /** what the owner's setup screen shows; never a credential */
  state(): Promise<Record<string, unknown>>;
  close(): void;
}

// --- the config ------------------------------------------------------------------

export interface LodyConfig {
  driver?: "fixture" | "cli" | "remote";
  /** cli: the Node that runs the CLI, and the CLI's entry script (or argv) */
  node?: string;
  cli?: string | string[];
  /** cli: LODY_DATA_DIR, when the bridge has an account of its own; a
   *  relative path is inside the service's store ("account") */
  dataDir?: string;
  /** cli: the name a sign-in made here registers this device under */
  machineName?: string;
  /** cli: the workspace to open first (id, slug or name) */
  workspace?: string;
  richTranscripts?: "export";
  allowSignOut?: boolean;
  /** remote: the far serve.ts and its key (or a file that holds it) */
  url?: string;
  key?: string;
  keyFile?: string;
  /** fixture: the fixture's time at its start, Unix ms */
  now?: number;
  /** fixture: start where a device without an account does, to show the way in: "setup" or "signed-out" */
  start?: "setup" | "signed-out";
}

const serviceDir = (storeDir: string) => join(storeDir, "services", "lody");

/** The config file's contents; `error` when one is there and cannot be read. */
export function loadConfig(storeDir: string): { config: LodyConfig; error?: string } {
  for (const file of [join(serviceDir(storeDir), "config.json"), join(storeDir, "config.json")]) {
    if (!existsSync(file)) continue;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("it is not a JSON object");
      const config = value as LodyConfig;
      if (config.driver !== undefined && config.driver !== "fixture" && config.driver !== "cli" && config.driver !== "remote") return { config: {}, error: `${file} names the driver "${String(config.driver)}"; it is "fixture", "cli" or "remote".` };
      return { config };
    } catch (error) {
      return { config: {}, error: `${file} cannot be read: ${(error as Error).message}. Fix or remove it.` };
    }
  }
  return { config: {} };
}

// --- finding the CLI ----------------------------------------------------------------

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

function nodeVersion(node: string): string | undefined {
  try {
    const result = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 5000 });
    return result.status === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The directories a bridge's own Node and CLI are kept in: the repository's
 *  cache (a development checkout) and the service's store. */
function cacheRoots(storeDir?: string, checkout = true): string[] {
  return [...(checkout ? [resolve(import.meta.dir, "../.cache")] : []), ...(storeDir ? [serviceDir(storeDir)] : [])];
}

/** A Node the lody CLI runs on and the CLI's entry script, or what is missing. */
export function locateCli(config: LodyConfig = {}, options: { storeDir?: string; env?: NodeJS.ProcessEnv; /** false: do not look in the checkout's own cache */ cache?: boolean } = {}): { node: string; cli: string[] } | { missing: string } {
  const env = options.env ?? process.env;
  const roots = cacheRoots(options.storeDir, options.cache !== false);

  let cli: string[] | undefined = config.cli === undefined ? undefined : typeof config.cli === "string" ? [config.cli] : config.cli;
  if (!cli) {
    for (const root of roots) {
      const script = join(root, "lody-cli", "node_modules", "lody", "dist", "index.js");
      if (existsSync(script)) {
        cli = [script];
        break;
      }
    }
  }
  if (!cli) {
    const found = onPath("lody", env);
    if (found) {
      try {
        cli = [realpathSync(found)];
      } catch {
        cli = [found];
      }
    }
  }
  if (!cli) return { missing: "The lody CLI is not installed on this computer. Install it (npm install -g lody) or set \"cli\" in the bridge's config." };

  if (config.node) return existsSync(config.node) ? { node: config.node, cli } : { missing: `Node is not at ${config.node}; fix "node" in the bridge's config.` };
  const candidates: string[] = [];
  for (const root of roots) {
    const dir = join(root, "node");
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort().reverse()) candidates.push(join(dir, entry, "bin", "node"));
  }
  const system = onPath("node", env);
  if (system) candidates.push(system);
  let seen: string | undefined;
  for (const node of candidates) {
    if (!existsSync(node)) continue;
    const version = nodeVersion(node);
    if (version && nodeRunsLody(version)) return { node, cli };
    seen ??= version;
  }
  return { missing: `The lody CLI needs Node 22.23.4+, 24.22.1+ or 26.12.1+${seen ? `; this computer's is ${seen}` : ", and none was found"}. Install one and set "node" in the bridge's config.` };
}

// --- setting up on the device ------------------------------------------------------

/** The name a sign-in made on this device registers it under. */
function deviceName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.POCKET_LODY_MACHINE_NAME) return env.POCKET_LODY_MACHINE_NAME;
  const id = env.OMARCHY_POCKET_HANDHELD;
  if (!id) return undefined;
  const known: Record<string, string> = { "ayn-thor": "AYN Thor", "retroid-pocket-duo-lite": "Retroid Pocket Duo Lite" };
  return known[id] ?? id.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** `base` (sample data, or a driver that says what is missing) until
 *  /setup has fetched the CLI; then the driver `then` makes. The service
 *  above sees one backend throughout. */
function withSetup(base: LodyBackend, options: { dir: string; deps: SetupDeps; log: (line: string) => void; then: (found: { node: string; cli: string }) => LodyBackend }): LodyBackend {
  const changes = new Changes();
  let current = base;
  let unsubscribe = current.subscribe((change) => changes.emit(change));
  let setup: Link["setup"] | undefined = { state: "needed" };
  let running: Promise<void> | undefined;
  let closed = false;

  const say = (next: Link["setup"]) => {
    setup = next;
    changes.snapshot();
  };

  return {
    get driver() {
      return current.driver;
    },
    async snapshot() {
      const snapshot = await current.snapshot();
      return setup ? { ...snapshot, link: { ...snapshot.link, setup } } : snapshot;
    },
    transcript: (id) => current.transcript(id),
    older: (id) => current.older(id),
    send: (request) => current.send(request),
    create: (request) => current.create(request),
    cancel: (id) => current.cancel(id),
    answer: (request) => current.answer(request),
    archive: (id, archived) => current.archive(id, archived),
    rename: (id, title) => current.rename(id, title),
    read: (id) => current.read(id),
    mentions: (query) => current.mentions(query),
    options: (machine) => current.options(machine),
    workspace: (id) => current.workspace(id),
    signin: () => current.signin(),
    signout: () => current.signout(),
    async setup() {
      if (!setup || running) return OK;
      say({ state: "running", step: "Starting…" });
      running = (async () => {
        try {
          const found = await installCli(options.dir, options.deps, (step) => !closed && say({ state: "running", step }));
          if (closed) return;
          const next = options.then(found);
          unsubscribe();
          current.close();
          current = next;
          unsubscribe = current.subscribe((change) => changes.emit(change));
          options.log("lody: set up on this device");
          say(undefined);
        } catch (error) {
          const why = error instanceof SetupError ? error.message : `Setting up failed: ${(error as Error).message}`;
          options.log(`lody setup failed: ${why}`);
          if (!closed) say({ state: "failed", step: why });
        } finally {
          running = undefined;
        }
      })();
      return OK;
    },
    subscribe: changes.subscribe,
    close() {
      closed = true;
      unsubscribe();
      current.close();
      changes.clear();
    },
  };
}

// --- picking the driver ----------------------------------------------------------------

/** The driver `config` names, or the default. Never throws: a driver that
 *  cannot be made is one that reports itself unavailable. */
export function createBackend(config: LodyConfig, context: ProviderContext, configError?: string): LodyBackend {
  if (configError) return unavailableBackend(config.driver ?? "none", configError);
  try {
    const dir = serviceDir(context.storeDir);
    const located = config.driver === "fixture" || config.driver === "remote" ? undefined : locateCli(config, { storeDir: context.storeDir, ...context.locate });
    const driver = config.driver ?? (located && "node" in located ? "cli" : "fixture");
    const cliBackend = (found: { node: string; cli: string[] }, with_: LodyConfig) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const cli: CliConfig = {
        node: found.node,
        cli: found.cli,
        cacheDir: dir,
        log: context.log,
        ...(with_.dataDir ? { dataDir: isAbsolute(with_.dataDir) ? with_.dataDir : join(dir, with_.dataDir) } : {}),
        ...(with_.machineName ? { machineName: with_.machineName } : {}),
        ...(with_.workspace ? { workspace: with_.workspace } : {}),
        ...(with_.richTranscripts === "export" ? { richTranscripts: "export" as const } : {}),
        ...(with_.allowSignOut ? { allowSignOut: true } : {}),
      };
      return createCliBackend(cli);
    };
    // A device that can fetch the CLI itself offers to, over sample data
    // (no driver chosen) or over the `cli` driver that found none. What it
    // sets up is an account of the device's own.
    const deps = context.setup ?? systemDeps();
    const offered = setupTarget(deps.platform, deps.arch) !== undefined && !config.node && !config.cli && (!located || "missing" in located) && config.driver !== "fixture" && config.driver !== "remote";
    const afterSetup = (found: { node: string; cli: string }) => {
      const name = config.machineName ?? deviceName(context.locate?.env);
      const next: LodyConfig = { ...config, driver: "cli", dataDir: config.dataDir ?? "account", ...(name ? { machineName: name } : {}) };
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, "config.json"), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      } catch (error) {
        context.log(`lody: the config could not be written: ${(error as Error).message}`);
      }
      return cliBackend({ node: found.node, cli: [found.cli] }, next);
    };
    if (driver === "fixture") {
      const fixture = createFixtureBackend({ auto: true, ...(typeof config.now === "number" ? { now: config.now } : {}), ...(config.start === "setup" || config.start === "signed-out" ? { start: config.start } : {}), ...(config.machineName ? { machine: config.machineName } : {}) });
      return offered ? withSetup(fixture, { dir, deps, log: context.log, then: afterSetup }) : fixture;
    }
    if (driver === "remote") {
      if (!config.url || !/^https?:\/\//.test(config.url)) return unavailableBackend("remote", "The bridge's config needs \"url\": the address of the computer running serve.ts, like http://192.168.1.20:4317.");
      let key = config.key;
      if (!key && config.keyFile) {
        try {
          key = readFileSync(config.keyFile, "utf8").trim();
        } catch {
          return unavailableBackend("remote", `The key file ${config.keyFile} cannot be read; fix "keyFile" in the bridge's config.`);
        }
      }
      return createRemoteBackend({ url: config.url, ...(key ? { key } : {}), log: context.log });
    }
    if (!located || "missing" in located) {
      if (offered) return withSetup(unavailableBackend("cli", "The Lody CLI is not on this device yet. Set it up to sign in."), { dir, deps, log: context.log, then: afterSetup });
      return unavailableBackend("cli", located?.missing ?? "The lody CLI was not looked for.");
    }
    return cliBackend(located, config);
  } catch (error) {
    return unavailableBackend(config.driver ?? "cli", `The bridge's driver could not start: ${(error as Error).message}`);
  }
}

export function createLodyProvider(context: ProviderContext): LodyProvider {
  let service: LodyService | undefined;
  let backend: LodyBackend | undefined;

  // made at the first request: a companion that lists its services starts no CLI
  function started(): LodyService {
    if (!service) {
      const { config, error } = loadConfig(context.storeDir);
      backend = createBackend(config, context, error);
      context.log(`lody: ${backend.driver} driver`);
      service = createLodyService(backend);
    }
    return service;
  }

  return {
    name: "lody",
    async handle(request) {
      return started().handle({ method: request.method, path: request.path, query: request.query, body: request.body, ...(request.signal ? { signal: request.signal } : {}) });
    },
    async state() {
      if (!backend) return { started: false };
      const { link } = await backend.snapshot();
      return { started: true, driver: link.driver, phase: link.phase, ...(link.via ? { via: link.via } : {}), ...(link.detail ? { detail: link.detail } : {}) };
    },
    close() {
      service?.close();
      service = undefined;
      backend = undefined;
    },
  };
}
