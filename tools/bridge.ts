// tools/bridge.ts — the applet's worker, for the simulator.
//
// PocketJS's sim runs no worker realm, so an applet's requests need the
// channel bridge the UI bundle looks for on globalThis
// (`__pocketWorkerChannels`, framework/src/worker-channels.ts). This one
// reads pocket-nexus/applets' request records (lib/net-wire.ts) and answers
// them from handlers by service name, each an async function: the `lody`
// service runs in process with its fixture driver, exactly the code the
// device's daemon runs. An answer leaves in records of the host's size, a
// ring's worth each frame, as the worker's does.
import { Answer, answerBytes, decodeRequest, encodeAnswer, encodeEnd, FLOOR_CHANNEL, NET_WORKER, Status, utf8 } from "../vendor/applets/lib/net-wire.ts";

export interface BridgeRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface BridgeAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export type BridgeHandler = (request: BridgeRequest) => Promise<BridgeAnswer> | BridgeAnswer;

export interface Bridge {
  /** install as globalThis.__pocketWorkerChannels before the bundle boots */
  channels: object;
  /** "METHOD host/path -> status", oldest first */
  log: string[];
  /** requests a handler has not answered yet, held ones (GET /sync) aside */
  busy(): number;
}

const REQUEST_ID = 1 + NET_WORKER.channels.findIndex((channel) => channel.name === "request");
const RESPONSE_ID = 1 + NET_WORKER.channels.findIndex((channel) => channel.name === "response");

/** `services` by the first path segment of https://companion.pocket/<name>/…; `tick` runs once a frame. */
export function createBridge(services: Record<string, BridgeHandler>, tick?: () => void): Bridge {
  const outgoing: Uint8Array[] = [];
  const log: string[] = [];
  let busy = 0;
  const chunk = answerBytes(FLOOR_CHANNEL.recordBytes);
  const queue = (id: number, kind: number, payload: Uint8Array) => {
    let at = 0;
    do {
      outgoing.push(encodeAnswer(id, kind, payload.subarray(at, at + chunk)));
      at += chunk;
    } while (at < payload.length);
  };
  const channels = {
    configure: () => Status.ok,
    publish(channel: number, data: Uint8Array): number {
      if (channel !== REQUEST_ID) return Status.invalid;
      const { id, descriptor } = decodeRequest(data.slice());
      const url = new URL(descriptor.url);
      const request: BridgeRequest = { url, method: descriptor.method ?? "GET", headers: descriptor.headers ?? {}, body: utf8(descriptor.body ?? "") };
      const name = url.host === "companion.pocket" ? url.pathname.split("/")[1]! : "";
      const handler = services[name];
      const line = `${request.method} ${url.host}${url.pathname}${url.search}`;
      const finish = (answer: BridgeAnswer) => {
        log.push(`${line} -> ${answer.status}`);
        const body = typeof answer.body === "string" ? utf8(answer.body) : (answer.body ?? new Uint8Array(0));
        queue(id, Answer.head, utf8(JSON.stringify({ status: answer.status, url: descriptor.url, headers: answer.headers ?? {} })));
        if (body.byteLength > 0) queue(id, Answer.body, body);
        queue(id, Answer.end, encodeEnd(Status.ok, ""));
      };
      if (!handler) {
        finish({ status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: `no ${name || url.host} service here` }) });
        return Status.ok;
      }
      const held = url.pathname.endsWith("/sync");
      if (!held) busy++;
      Promise.resolve(handler(request))
        .then(finish, (error) => {
          log.push(`${line} -> failed ${error}`);
          queue(id, Answer.end, encodeEnd(Status.failed, `other: ${error instanceof Error ? error.message : String(error)}`));
        })
        .finally(() => {
          if (!held) busy--;
        });
      return Status.ok;
    },
    observe(channel: number): Uint8Array[] {
      if (channel !== RESPONSE_ID) return [];
      tick?.();
      return outgoing.splice(0, FLOOR_CHANNEL.capacity * 8);
    },
  };
  return { channels, log, busy: () => busy };
}
