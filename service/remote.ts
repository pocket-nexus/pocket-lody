// pocket-lody/service/remote.ts — a driver whose driver is on another
// computer. A handheld's own daemon cannot run the lody CLI; the owner's
// computer can, and serves it (serve.ts). This file is both ends of what
// they say to each other, under `/lody/_backend` beside the applet's routes:
//
//   POST /_backend/call        {method, args}  → {ok: true, value} | {ok: false, error}
//   POST /_backend/transcript  {id, since}     → {gone: true} | {rev, state, can, activeTurn?, complete, items, order}
//   GET  /_backend/changes?epoch=<e>&seq=<n>&wait=<s>  → {epoch, seq, changes, reset?}
//
// `call` is one LodyBackend method. `transcript` is the far driver's
// transcript as an increment: the items that changed since `since` and every
// id in order, so a long session's text is not sent again for each word an
// agent adds. `changes` is the long poll that carries the far driver's
// change events: it is answered when one happens or after `wait` seconds.
// `epoch` names one life of the far process; a different one, or a `seq` it
// no longer holds, answers `reset`, and the near side asks for everything.
//
// Both ends authenticate as serve.ts does: `Authorization: Bearer <key>`.

import type { ActionResponse, CreateOptions, Item, Link, MentionRow } from "../protocol.ts";
import { Changes, refuse, type BackendChange, type BackendSnapshot, type BackendTranscript, type LodyBackend } from "./backend.ts";
import { TranscriptLedger, type LodyServiceRequest, type LodyServiceResponse } from "./service.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CHANGES_HELD = 512;
const WAIT_MAX_S = 25;
const LEDGERS_MAX = 64;

const CALLS = new Set(["snapshot", "older", "send", "create", "cancel", "answer", "archive", "rename", "read", "mentions", "options", "workspace", "signin", "signout"]);

interface TranscriptReply {
  gone?: boolean;
  rev: number;
  state: BackendTranscript["state"];
  can: BackendTranscript["can"];
  activeTurn?: string;
  complete: boolean;
  items: Item[];
  order: string[];
}

interface ChangesReply {
  epoch: string;
  seq: number;
  changes: BackendChange[];
  reset?: boolean;
}

function json(status: number, value: unknown): LodyServiceResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: encoder.encode(JSON.stringify(value)) };
}

// ---------------------------------------------------------------------------
// The far end: a driver, served.
// ---------------------------------------------------------------------------

export interface BackendRpc {
  /** Answers a request under `/_backend`; `path` is what follows it. */
  handle(request: LodyServiceRequest): Promise<LodyServiceResponse>;
  close(): void;
}

export function createBackendRpc(backend: LodyBackend, options: { now?: () => number } = {}): BackendRpc {
  const now = options.now ?? Date.now;
  const epoch = `${now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  let counter = now();
  const next = () => ++counter;
  const ledgers = new Map<string, TranscriptLedger>();
  const held: { seq: number; change: BackendChange }[] = [];
  let seq = 0;
  const waiters = new Set<() => void>();
  let closed = false;

  const unsubscribe = backend.subscribe((change) => {
    held.push({ seq: ++seq, change });
    if (held.length > CHANGES_HELD) held.shift();
    for (const waiter of [...waiters]) waiter();
  });

  function body(request: LodyServiceRequest): Record<string, unknown> {
    try {
      const value = JSON.parse(decoder.decode(request.body)) as unknown;
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async function changes(request: LodyServiceRequest): Promise<LodyServiceResponse> {
    const from = Number(request.query.get("seq") ?? -1);
    const waitS = Number(request.query.get("wait") ?? 0);
    const waitMs = Number.isFinite(waitS) ? Math.min(WAIT_MAX_S, Math.max(0, waitS)) * 1000 : 0;
    const oldest = held[0]?.seq ?? seq + 1;
    if (request.query.get("epoch") !== epoch || !Number.isInteger(from) || from > seq || from < oldest - 1) return json(200, { epoch, seq, changes: [], reset: true } satisfies ChangesReply);
    if (seq === from && waitMs > 0 && !closed && !request.signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          request.signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        waiters.add(done);
        request.signal?.addEventListener("abort", done, { once: true });
      });
    }
    // the same session many times over is one change
    const seen = new Set<string>();
    const out: BackendChange[] = [];
    for (const entry of held) {
      if (entry.seq <= from) continue;
      const key = entry.change.kind === "snapshot" ? "" : entry.change.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry.change);
    }
    return json(200, { epoch, seq, changes: out } satisfies ChangesReply);
  }

  async function transcript(request: LodyServiceRequest): Promise<LodyServiceResponse> {
    const input = body(request);
    const id = typeof input.id === "string" ? input.id : "";
    const since = typeof input.since === "number" ? input.since : -1;
    if (!id) return json(400, { ok: false, error: "A transcript is asked for by its session's id." });
    const now = await backend.transcript(id);
    if (!now) {
      ledgers.delete(id);
      return json(200, { ok: true, value: { gone: true } });
    }
    let ledger = ledgers.get(id);
    if (!ledger) {
      if (ledgers.size >= LEDGERS_MAX) ledgers.delete(ledgers.keys().next().value!);
      ledger = new TranscriptLedger();
      ledgers.set(id, ledger);
    }
    ledger.absorb(now, next);
    const part = ledger.all(since);
    const value: TranscriptReply = { rev: part.rev, state: now.state, can: now.can, ...(now.activeTurn ? { activeTurn: now.activeTurn } : {}), complete: now.complete, items: part.items, order: part.order };
    return json(200, { ok: true, value });
  }

  async function call(request: LodyServiceRequest): Promise<LodyServiceResponse> {
    const input = body(request);
    const method = typeof input.method === "string" ? input.method : "";
    const args = Array.isArray(input.args) ? input.args : [];
    if (!CALLS.has(method)) return json(404, { ok: false, error: `The bridge has no backend call named ${method || "(nothing)"}.` });
    const value = await (backend as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!(...args);
    return json(200, { ok: true, value });
  }

  return {
    async handle(request) {
      try {
        if (closed) return json(503, { ok: false, error: "The bridge is shutting down; try again in a moment." });
        if (request.path === "/changes" && request.method === "GET") return await changes(request);
        if (request.path === "/transcript" && request.method === "POST") return await transcript(request);
        if (request.path === "/call" && request.method === "POST") return await call(request);
        return json(404, { ok: false, error: `The bridge has no route ${request.method} /_backend${request.path}.` });
      } catch (error) {
        return json(502, { ok: false, error: `The bridge's driver failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` });
      }
    },
    close() {
      closed = true;
      unsubscribe();
      for (const waiter of [...waiters]) waiter();
    },
  };
}

// ---------------------------------------------------------------------------
// The near end: a driver that asks the far one.
// ---------------------------------------------------------------------------

export interface RemoteConfig {
  /** the far serve.ts: "http://192.168.1.20:4317" */
  url: string;
  /** the key it was started with */
  key?: string;
  /** seconds a change poll is held; at most 25 */
  waitSeconds?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface HeldTranscript {
  rev: number;
  items: Map<string, Item>;
  last?: BackendTranscript;
}

export function createRemoteBackend(config: RemoteConfig): LodyBackend {
  const base = `${config.url.replace(/\/+$/, "")}/lody/_backend`;
  const host = (() => {
    try {
      return new URL(config.url).host;
    } catch {
      return config.url;
    }
  })();
  const doFetch = config.fetch ?? fetch;
  const log = config.log ?? (() => {});
  const waitS = Math.min(WAIT_MAX_S, Math.max(0, config.waitSeconds ?? WAIT_MAX_S));
  const changes = new Changes();
  const stop = new AbortController();
  const headers: Record<string, string> = { "content-type": "application/json", ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) };
  const transcripts = new Map<string, HeldTranscript>();
  let snapshot: BackendSnapshot | undefined;
  let down: string | undefined;
  let closed = false;

  /** Why the far bridge cannot be used, as a sentence. */
  function trouble(error: unknown, status?: number): string {
    if (status === 401 || status === 403) return `The bridge at ${host} refused this device's key; put the key it was started with in this device's config.`;
    if (status) return `The bridge at ${host} answered ${status}.`;
    return `The bridge at ${host} does not answer (${error instanceof Error ? error.message.slice(0, 120) : "no connection"}). Check that it is running and that this device is on its network.`;
  }

  async function ask<T>(path: string, init: { method: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { method: init.method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), signal: init.signal ? AbortSignal.any([init.signal, stop.signal]) : stop.signal });
    } catch (error) {
      throw new Error(trouble(error));
    }
    let value: { ok?: boolean; error?: string; value?: unknown } | undefined;
    try {
      value = (await response.json()) as typeof value;
    } catch {
      value = undefined;
    }
    if (response.status === 401 || response.status === 403 || !value) throw new Error(trouble(undefined, response.status));
    if (path.startsWith("/changes")) return value as T;
    if (value.ok === false) throw new Error(value.error ?? trouble(undefined, response.status));
    return value.value as T;
  }

  const call = <T>(method: string, ...args: unknown[]) => ask<T>("/call", { method: "POST", body: { method, args } });

  /** An action: a far refusal is its sentence; a bridge that cannot be reached is one too. */
  async function act(method: string, ...args: unknown[]): Promise<ActionResponse> {
    try {
      return await call<ActionResponse>(method, ...args);
    } catch (error) {
      return refuse((error as Error).message);
    }
  }

  function relink(far: Link): Link {
    return { ...far, driver: "remote", via: far.via ?? host };
  }

  async function pullSnapshot() {
    const far = await call<BackendSnapshot>("snapshot");
    snapshot = { ...far, link: relink(far.link) };
    down = undefined;
    changes.snapshot();
  }

  // --- the far driver's changes, as they happen -----------------------------------
  let started: Promise<void> | undefined;

  async function follow() {
    let epoch = "";
    let seq = -1;
    let backoff = 500;
    while (!closed) {
      try {
        const reply = await ask<ChangesReply>(`/changes?epoch=${encodeURIComponent(epoch)}&seq=${seq}&wait=${waitS}`, { method: "GET" });
        backoff = 500;
        const again = down !== undefined;
        if (reply.reset || again) {
          epoch = reply.epoch;
          seq = reply.seq;
          for (const held of transcripts.values()) held.rev = -1;
          await pullSnapshot();
          for (const id of transcripts.keys()) changes.session(id);
          continue;
        }
        seq = reply.seq;
        for (const change of reply.changes) {
          if (change.kind === "snapshot") await pullSnapshot();
          else changes.session(change.id);
        }
      } catch (error) {
        if (closed) return;
        const reason = (error as Error).message;
        if (down !== reason) {
          down = reason;
          log(`lody remote: ${reason}`);
          changes.snapshot();
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(15_000, backoff * 2);
      }
    }
  }

  const start = () =>
    (started ??= (async () => {
      try {
        await pullSnapshot();
      } catch (error) {
        down = (error as Error).message;
      }
      void follow();
    })());

  return {
    driver: "remote",
    async snapshot() {
      await start();
      if (down || !snapshot) return { link: { phase: "unavailable", driver: "remote", via: host, detail: down ?? `The bridge at ${host} has not answered yet.` }, workspaces: [], machines: [], sessions: [] };
      return snapshot;
    },
    async transcript(sessionId) {
      await start();
      const held = transcripts.get(sessionId) ?? { rev: -1, items: new Map<string, Item>() };
      const reply = await ask<TranscriptReply>("/transcript", { method: "POST", body: { id: sessionId, since: held.rev } });
      if (reply.gone) {
        transcripts.delete(sessionId);
        return null;
      }
      for (const item of reply.items) held.items.set(item.id, item);
      const order = new Set(reply.order);
      for (const id of [...held.items.keys()]) if (!order.has(id)) held.items.delete(id);
      // an id the far side lists and this side lost: ask for everything next time
      const items: Item[] = [];
      let whole = true;
      for (const id of reply.order) {
        const item = held.items.get(id);
        if (item) items.push(item);
        else whole = false;
      }
      held.rev = whole ? reply.rev : -1;
      transcripts.set(sessionId, held);
      held.last = { state: reply.state, can: reply.can, ...(reply.activeTurn ? { activeTurn: reply.activeTurn } : {}), items, complete: reply.complete };
      return held.last;
    },
    async older(sessionId) {
      try {
        return await call<boolean>("older", sessionId);
      } catch {
        return false;
      }
    },
    send: (request) => act("send", request),
    create: (request) => act("create", request),
    cancel: (sessionId) => act("cancel", sessionId),
    answer: (request) => act("answer", request),
    archive: (sessionId, archived) => act("archive", sessionId, archived),
    rename: (sessionId, title) => act("rename", sessionId, title),
    read: (sessionId) => act("read", sessionId),
    async mentions(query) {
      try {
        return await call<MentionRow[]>("mentions", query);
      } catch {
        return [];
      }
    },
    async options(machineId) {
      try {
        return await call<CreateOptions>("options", ...(machineId ? [machineId] : []));
      } catch {
        return { machines: [], agents: [], projects: [] };
      }
    },
    workspace: (id) => act("workspace", id),
    signin: () => act("signin"),
    signout: () => act("signout"),
    subscribe: changes.subscribe,
    close() {
      closed = true;
      stop.abort();
      changes.clear();
    },
  };
}
