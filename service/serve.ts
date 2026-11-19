#!/usr/bin/env bun
// pocket-lody/service/serve.ts — the `lody` service as an HTTP server.
//
//   bun service/serve.ts [--driver fixture|cli|remote] [--port 4317]
//       [--host 127.0.0.1] [--key <key> | --key-file <path>] [--config <file>]
//
// Without --config the driver's config is .cache/bridge/config.json
// in the repository when there is one (provider.ts has its fields); --driver
// overrides the driver it names. With neither, the driver is `cli` when a
// lody CLI and a Node it runs on are found, else `fixture`.
//
// The applet's routes are under /lody (GET /lody/sync, POST /lody/send, …),
// and a far driver's under /lody/_backend (remote.ts). With a key, every
// request must carry `Authorization: Bearer <key>`. Without one the server
// binds only a loopback address: anyone who can reach it can read the
// workspace and send messages as its owner.
//
// One line is logged per request: the method, the path, the status, the
// size and the time. Never a query, a body, a header or the key.

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LodyBackend } from "./backend.ts";
import { createBackend, loadConfig, type LodyConfig } from "./provider.ts";
import { createBackendRpc } from "./remote.ts";
import { createLodyService, type LodyServiceOptions } from "./service.ts";

export interface ServeOptions {
  /** a driver already made (tests); otherwise `config` picks one */
  backend?: LodyBackend;
  config?: LodyConfig;
  /** where a driver keeps its files; default .cache/bridge in the repository */
  storeDir?: string;
  port?: number;
  host?: string;
  key?: string;
  log?: (line: string) => void;
  service?: LodyServiceOptions;
}

export interface Served {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const encoder = new TextEncoder();

function sameKey(given: string, key: string): boolean {
  const a = encoder.encode(given);
  const b = encoder.encode(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startServer(options: ServeOptions = {}): Served {
  const host = options.host ?? "127.0.0.1";
  const key = options.key;
  if (!key && !LOOPBACK.has(host)) throw new Error(`Refusing to listen on ${host} without a key: pass --key or --key-file, or use --host 127.0.0.1.`);
  if (key !== undefined && key.length < 8) throw new Error("The key must be at least 8 characters.");
  const log = options.log ?? (() => {});
  const storeDir = options.storeDir ?? resolve(import.meta.dir, "../.cache/bridge");
  const backend = options.backend ?? createBackend(options.config ?? {}, { storeDir, log });
  const service = createLodyService(backend, options.service);
  const rpc = createBackendRpc(backend);

  const refused = (status: number, error: string) => Response.json({ ok: false, error }, { status });

  const server = Bun.serve({
    port: options.port ?? 4317,
    hostname: host,
    // a held /sync is quiet for up to 25 s
    idleTimeout: 120,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      const started = Date.now();
      const url = new URL(request.url);
      let response: Response;
      try {
        response = await answer(request, url);
      } catch (error) {
        response = refused(500, `The bridge failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      }
      const size = response.headers.get("content-length") ?? "?";
      log(`${request.method} ${url.pathname} ${response.status} ${size}B ${Date.now() - started}ms`);
      return response;
    },
  });

  async function answer(request: Request, url: URL): Promise<Response> {
    if (key) {
      const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
      if (!sameKey(given, key)) return refused(401, "This bridge needs its key: send Authorization: Bearer <key>.");
    }
    if (url.pathname !== "/lody" && !url.pathname.startsWith("/lody/")) return refused(404, "This server answers only under /lody.");
    const rest = url.pathname.slice("/lody".length) || "/";
    const body = request.method === "GET" || request.method === "HEAD" ? new Uint8Array(0) : new Uint8Array(await request.arrayBuffer());
    const inner = { method: request.method, query: url.searchParams, body, signal: request.signal };
    const result = rest === "/_backend" || rest.startsWith("/_backend/") ? await rpc.handle({ ...inner, path: rest.slice("/_backend".length) || "/" }) : await service.handle({ ...inner, path: rest });
    return new Response(result.body, { status: result.status === 499 ? 408 : result.status, headers: { ...result.headers, "content-length": String(result.body.length) } });
  }

  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${server.port}`,
    port: server.port!,
    async stop() {
      rpc.close();
      service.close();
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("bun service/serve.ts [--driver fixture|cli|remote] [--port 4317] [--host 127.0.0.1] [--key <key> | --key-file <path>] [--config <file>]");
    process.exit(0);
  }
  try {
    // --config, else the store's own config.json, else the default driver
    const file = flag("--config");
    const storeDir = resolve(import.meta.dir, "../.cache/bridge");
    const stored = file ? undefined : loadConfig(storeDir);
    if (stored?.error) throw new Error(stored.error);
    const config: LodyConfig = file ? (JSON.parse(readFileSync(file, "utf8")) as LodyConfig) : stored!.config;
    const driver = flag("--driver");
    if (driver !== undefined && driver !== "fixture" && driver !== "cli" && driver !== "remote") throw new Error(`--driver is fixture, cli or remote, not ${driver}.`);
    if (driver) config.driver = driver;
    const keyFile = flag("--key-file");
    const key = keyFile ? readFileSync(keyFile, "utf8").trim() : flag("--key");
    const port = Number(flag("--port") ?? 4317);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port is a number from 0 to 65535.");
    const stamp = () => new Date().toISOString().slice(11, 19);
    const served = startServer({ config, storeDir, port, host: flag("--host") ?? "127.0.0.1", ...(key ? { key } : {}), log: (line) => console.log(`${stamp()} ${line}`) });
    console.log(`${stamp()} lody bridge on ${served.url}/lody (${config.driver ?? "the driver the config picks"}${key ? ", key required" : ", no key: loopback only"})`);
    const quit = () => void served.stop().then(() => process.exit(0));
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
