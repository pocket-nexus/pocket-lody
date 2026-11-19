// pocket-lody/app/store.ts — the workspace as the applet holds it: the
// snapshot and the open session's transcript, kept current by one held
// request to the `lody` service (protocol.ts GET /sync).
//
// The transport is given: `request(path, init)` performs one HTTP-shaped
// request and resolves with the status and the decoded JSON. In the applet
// it is the worker's http node (app/net.ts); in tests it calls the service
// in process. Time is given too (`after`), because the applet's realm has no
// timers and its clock stops while its window is off screen.
import { batch, createSignal, type Accessor } from "solid-js";
import type { ActionResponse, CreateOptions, CreateRequest, Item, Link, MentionRow, SendRequest, SessionRow, SessionState, Snapshot, SyncResponse, Transcript } from "../protocol.ts";

export interface Transport {
  request(path: string, init?: { method?: "GET" | "POST"; body?: string; type?: string; timeoutMs?: number }): Promise<{ status: number; json: unknown }>;
  /** run `fn` after `seconds`; returns what cancels it */
  after(seconds: number, fn: () => void): () => void;
}

export interface OpenTranscript {
  sessionId: string;
  items: Item[];
  state: SessionState;
  can: Transcript["can"];
  activeTurn?: string;
  older: boolean;
  /** nothing has arrived for it yet */
  loading: boolean;
  loadingOlder: boolean;
}

export type Connection = "connecting" | "online" | "offline";

export interface LodyStore {
  connection: Accessor<Connection>;
  /** why it is offline, as a sentence */
  failure: Accessor<string>;
  snapshot: Accessor<Snapshot | null>;
  link: Accessor<Link | null>;
  sessions: Accessor<readonly SessionRow[]>;
  session(id: string): SessionRow | undefined;
  /** the transcript of the session `open` named, or null */
  transcript: Accessor<OpenTranscript | null>;
  /** which session's transcript is kept current */
  open(sessionId: string | null): void;
  loadOlder(): void;
  send(request: SendRequest): Promise<ActionResponse>;
  create(request: CreateRequest): Promise<ActionResponse>;
  act(path: "/cancel" | "/answer" | "/archive" | "/rename" | "/read" | "/workspace" | "/signin" | "/signout" | "/setup", body: Record<string, unknown>): Promise<ActionResponse>;
  mentions(query: string, sessionId?: string): Promise<MentionRow[]>;
  options(machineId?: string): Promise<CreateOptions>;
  /** ask again now: after a failure, or when the window comes back */
  retry(): void;
  stop(): void;
}

/** A long text goes up in parts of at most this many UTF-8 bytes (one request holds 1020 with its URL and headers). */
const PART_BYTES = 600;
/** What one request's body may hold before it is sent as a draft. */
const INLINE_BYTES = 520;
const WAIT_SECONDS = 20;

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** `text` in pieces of at most `limit` UTF-8 bytes, never inside a surrogate pair. */
export function partsOf(text: string, limit = PART_BYTES): string[] {
  const parts: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff;
    const size = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > limit && i > start) {
      parts.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    if (pair) i++;
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start));
  return parts;
}

/** Merge changed items into the held ones by id, in `order`. An item that did not change keeps its object, so a row drawn from it does not lay out again. */
export function mergeItems(held: readonly Item[], changed: readonly Item[], order: readonly string[] | undefined): Item[] {
  const byId = new Map<string, Item>();
  for (const item of held) byId.set(item.id, item);
  for (const item of changed) {
    const before = byId.get(item.id);
    byId.set(item.id, before && JSON.stringify(before) === JSON.stringify(item) ? before : item);
  }
  if (!order) {
    // a page: the changed items are the whole list
    return changed.map((item) => byId.get(item.id)!);
  }
  const out: Item[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) out.push(item);
  }
  return out;
}

export function createLodyStore(transport: Transport): LodyStore {
  const [connection, setConnection] = createSignal<Connection>("connecting");
  const [failure, setFailure] = createSignal("");
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null);
  const [transcript, setTranscript] = createSignal<OpenTranscript | null>(null);
  let rev = 0;
  let srev = 0;
  let openId: string | null = null;
  /** bumps when the sync loop must start over: another session opened, a retry */
  let generation = 0;
  let stopped = false;
  let cancelRetry: (() => void) | null = null;
  let failures = 0;
  let draftSeq = 0;
  /** transcripts of sessions opened before, to show at once on return */
  const kept = new Map<string, { transcript: OpenTranscript; srev: number }>();

  const applySnapshot = (next: Snapshot) => {
    const before = snapshot();
    if (before) {
      // rows that did not change keep their objects
      const byId = new Map(before.sessions.map((row) => [row.id, row]));
      next = { ...next, sessions: next.sessions.map((row) => { const old = byId.get(row.id); return old && JSON.stringify(old) === JSON.stringify(row) ? old : row; }) };
    }
    rev = next.rev;
    setSnapshot(next);
  };

  const applyTranscript = (next: Transcript, incremental: boolean) => {
    if (next.sessionId !== openId) return;
    const held = transcript();
    const items = mergeItems(held && held.sessionId === next.sessionId ? held.items : [], next.items, incremental ? next.order : undefined);
    srev = next.rev;
    const value: OpenTranscript = { sessionId: next.sessionId, items, state: next.state, can: next.can, activeTurn: next.activeTurn, older: next.older, loading: false, loadingOlder: false };
    kept.set(next.sessionId, { transcript: value, srev });
    if (kept.size > 6) kept.delete(kept.keys().next().value!);
    setTranscript(value);
  };

  const loop = async (mine: number) => {
    while (!stopped && mine === generation) {
      const query = `/sync?rev=${rev}${openId ? `&session=${encodeURIComponent(openId)}&srev=${srev}` : ""}&wait=${rev === 0 || (openId && srev === 0) ? 0 : WAIT_SECONDS}`;
      try {
        const { status, json } = await transport.request(query, { timeoutMs: (WAIT_SECONDS + 12) * 1000 });
        if (stopped || mine !== generation) return;
        if (status !== 200) throw new Error(typeof (json as { error?: string })?.error === "string" ? (json as { error: string }).error : `The Lody service answered ${status}.`);
        const answer = json as SyncResponse;
        failures = 0;
        batch(() => {
          setConnection("online");
          setFailure("");
          if (answer.snapshot) applySnapshot(answer.snapshot);
          if (answer.transcript) applyTranscript(answer.transcript, srev > 0 && answer.transcript.order !== undefined);
        });
      } catch (error) {
        if (stopped || mine !== generation) return;
        failures++;
        batch(() => {
          setConnection("offline");
          setFailure(error instanceof Error ? error.message : String(error));
        });
        // wait before asking again: 2 s, 4 s, 8 s, then every 15 s
        await new Promise<void>((resolve) => {
          cancelRetry = transport.after(Math.min(15, 2 ** failures), () => {
            cancelRetry = null;
            resolve();
          });
        });
      }
    }
  };

  const restart = () => {
    generation++;
    cancelRetry?.();
    cancelRetry = null;
    void loop(generation);
  };

  const post = async (path: string, body: unknown): Promise<ActionResponse> => {
    try {
      const { json } = await transport.request(path, { method: "POST", body: JSON.stringify(body), type: "application/json" });
      const answer = json as ActionResponse | null;
      return answer && typeof answer.ok === "boolean" ? answer : { ok: false, error: "The Lody service gave no answer." };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  /** A text small enough goes in the request; a longer one goes up first as a draft's parts. */
  const withText = async <T extends { text?: string; draft?: string }>(request: T): Promise<T | ActionResponse> => {
    const text = request.text ?? "";
    if (utf8Bytes(JSON.stringify(request)) <= INLINE_BYTES) return request;
    const draft = `d${Date.now().toString(36)}${(draftSeq++).toString(36)}`;
    const parts = partsOf(text);
    for (let part = 0; part < parts.length; part++) {
      try {
        const { status } = await transport.request(`/draft?id=${draft}&part=${part}`, { method: "POST", body: parts[part], type: "text/plain" });
        if (status !== 200) return { ok: false, error: "The message could not be sent: it is too long for the service." };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { ...request, text: undefined, draft };
  };

  restart();

  return {
    connection,
    failure,
    snapshot,
    link: () => snapshot()?.link ?? null,
    sessions: () => snapshot()?.sessions ?? [],
    session: (id) => snapshot()?.sessions.find((row) => row.id === id),
    transcript,
    open(sessionId) {
      if (sessionId === openId) return;
      openId = sessionId;
      const held = sessionId ? kept.get(sessionId) : undefined;
      srev = held?.srev ?? 0;
      setTranscript(sessionId ? (held?.transcript ?? { sessionId, items: [], state: "idle", can: { send: false, cancel: false, answer: false }, older: false, loading: true, loadingOlder: false }) : null);
      restart();
    },
    loadOlder() {
      const held = transcript();
      if (!held || !held.older || held.loadingOlder || held.items.length === 0) return;
      const mine = held.sessionId;
      setTranscript({ ...held, loadingOlder: true });
      transport.request(`/session?id=${encodeURIComponent(mine)}&before=${encodeURIComponent(held.items[0]!.id)}&limit=40`).then(
        ({ status, json }) => {
          const now = transcript();
          if (!now || now.sessionId !== mine) return;
          if (status !== 200) return setTranscript({ ...now, loadingOlder: false });
          const page = json as Transcript;
          const known = new Set(now.items.map((item) => item.id));
          const value = { ...now, items: [...page.items.filter((item) => !known.has(item.id)), ...now.items], older: page.older, loadingOlder: false };
          kept.set(mine, { transcript: value, srev });
          setTranscript(value);
        },
        () => {
          const now = transcript();
          if (now && now.sessionId === mine) setTranscript({ ...now, loadingOlder: false });
        },
      );
    },
    async send(request) {
      const ready = await withText(request);
      return "ok" in ready ? ready : post("/send", ready);
    },
    async create(request) {
      const ready = await withText(request);
      return "ok" in ready ? ready : post("/create", ready);
    },
    act: (path, body) => post(path, body),
    async mentions(query, sessionId) {
      try {
        const { status, json } = await transport.request(`/mentions?q=${encodeURIComponent(query)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`);
        return status === 200 && Array.isArray(json) ? (json as MentionRow[]) : [];
      } catch {
        return [];
      }
    },
    async options(machineId) {
      const { status, json } = await transport.request(`/options${machineId ? `?machine=${encodeURIComponent(machineId)}` : ""}`);
      if (status !== 200) throw new Error("The Lody service could not list machines and agents.");
      return json as CreateOptions;
    },
    retry() {
      failures = 0;
      restart();
    },
    stop() {
      stopped = true;
      generation++;
      cancelRetry?.();
    },
  };
}
