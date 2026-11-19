// pocket-lody/app/net.ts — the applet's transport: requests to the `lody`
// companion service through the applet's worker.
//
// The UI realm has no network. pocket-nexus/applets' lib/net.ts carries a
// request to the worker the manifest declares (lib/net-worker.ts), whose
// http node is omarchy-pocketd on Omarchy Pocket and Pocket Hub on a paired
// Mac elsewhere; both answer https://companion.pocket/lody/… with the
// service in pocket-lody/service.
import { after } from "@pocketjs/framework/clock";
import { companionService, fetch, NET_MAX_RESPONSE_BYTES } from "../vendor/applets/lib/net.ts";
import type { Transport } from "./store.ts";

/** A snapshot of a busy workspace or a long transcript page: well over the 128 KiB default. */
const MAX_BYTES = Math.min(NET_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);

export const transport: Transport = {
  async request(path, init = {}) {
    const response = await fetch(companionService("lody", path), {
      method: init.method ?? "GET",
      headers: init.body !== undefined ? { "content-type": init.type ?? "application/json" } : undefined,
      body: init.body,
      timeoutMs: init.timeoutMs ?? 30_000,
      maxBytes: MAX_BYTES,
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // an answer that is not JSON has no fields to read; the status says the rest
    }
    return { status: response.status, json };
  },
  after,
};

/** What the application keeps between runs, in the companion's `store`
 *  service (a JSON value by name, at most what one request carries). */
export const memory = {
  async load<T>(name: string): Promise<T | null> {
    try {
      const response = await fetch(companionService("store", `/get?name=${encodeURIComponent(name)}`));
      if (!response.ok) return null;
      return ((await response.json()) as { value?: T | null }).value ?? null;
    } catch {
      return null;
    }
  },
  save(name: string, value: unknown): void {
    void fetch(companionService("store", `/set?name=${encodeURIComponent(name)}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }).catch(() => {});
  },
};
