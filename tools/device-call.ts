#!/usr/bin/env bun
// bun device-call.ts <METHOD> <path> [json body]      (run in the device's Linux root)
//
// One request to the `lody` companion service as the applet's worker makes
// it: an `appNet` line on omarchy-pocketd's bridge socket, answered by an
// `@net` line (daemon/companion.ts). It prints the response's status on
// stderr and its body on stdout, so a loop on a device can be driven and
// read without the applet: `bun tools/thor.ts call GET '/sync?rev=-1'`.
//
// POCKET_LODY_PACKAGE names the installed package the request is made as
// (its manifest is what admits it to the service).
import { connect } from "node:net";
import { join } from "node:path";

const [method = "GET", path = "/sync?rev=-1", body = ""] = process.argv.slice(2);
const home = process.env.HOME ?? "/home/omarchy";
const pkg = process.env.POCKET_LODY_PACKAGE ?? join(home, ".local/share/omarchy-pocket/applets/lody.pocket");
const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
const timeoutMs = Number(process.env.POCKET_LODY_TIMEOUT_MS ?? 60_000);
const h = 0x40000000 + Math.floor(Math.random() * 0x3fffffff);

const headers: Record<string, string> = body ? { "content-type": "application/json" } : {};
const meta = JSON.stringify({ url: `https://companion.pocket/lody${path}`, method, headers, timeoutMs, maxBytes: 512 * 1024 });
const line = `${JSON.stringify({ method: "appNet", h, package: pkg, meta, body: Buffer.from(body).toString("base64") })}\n`;

const socket = connect(join(runtime, "omarchy-pocket", "bridge.sock"));
const timer = setTimeout(() => {
  console.error(`no answer in ${timeoutMs} ms`);
  process.exit(3);
}, timeoutMs + 2000);
let incoming = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(line));
socket.on("error", (error) => {
  console.error(`the bridge socket: ${error.message}`);
  process.exit(2);
});
socket.on("data", (chunk: string) => {
  incoming += chunk;
  let end: number;
  while ((end = incoming.indexOf("\n")) >= 0) {
    const text = incoming.slice(0, end);
    incoming = incoming.slice(end + 1);
    // the daemon's events to the shell pass by on the same socket
    if (!text.startsWith(`@net ${h} `)) continue;
    const rest = text.slice(`@net ${h} `.length);
    const space = rest.indexOf(" ");
    const payload = rest.slice(0, space);
    const event = JSON.parse(rest.slice(space + 1)) as { t: string; status?: number; code?: string; message?: string };
    clearTimeout(timer);
    if (event.t !== "done") {
      console.error(`${event.code ?? "error"}: ${event.message ?? ""}`);
      process.exit(1);
    }
    console.error(`status ${event.status}`);
    process.stdout.write(payload === "-" ? "" : Buffer.from(payload, "base64").toString("utf8"));
    process.stdout.write("\n");
    socket.end();
    process.exit(event.status && event.status < 400 ? 0 : 1);
  }
});
