// pocket-lody/service/service.ts — the `lody` companion service's routes
// (../protocol.ts) over a driver (backend.ts).
//
// The service owns what the transport forces on the applet's side of the
// contract and a driver should not care about:
//  - Revisions. One counter numbers every change. A snapshot's `rev` is the
//    counter's value when the workspace last differed from what was answered
//    before; a transcript's `rev` and each of its items' are the same for a
//    session. The counter starts at the clock's milliseconds, so a service
//    that restarts never answers a number an applet already holds.
//  - The long poll. GET /sync is held until a number the applet named is
//    behind, `wait` seconds pass, or the request is aborted.
//  - Pages and increments of a transcript. The service remembers the oldest
//    item it has given out for a session (the window); an increment's `order`
//    lists the window's ids, and `older` says whether anything is before it.
//  - Drafts: a prompt longer than one request arrives in parts and is joined
//    when a /send or /create names it.
//
// Every failure is JSON `{ok: false, error}` with a sentence for a person.

import { PROTOCOL, type ActionResponse, type CreateRequest, type Item, type MentionRow, type SendRequest, type SessionRow, type Snapshot, type SyncResponse, type Transcript } from "../protocol.ts";
import type { BackendChange, BackendTranscript, LodyBackend } from "./backend.ts";

export interface LodyServiceRequest {
  method: string;
  /** the path after the service's name, from "/" */
  path: string;
  query: URLSearchParams;
  body: Uint8Array;
  signal?: AbortSignal;
}

export interface LodyServiceResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface LodyService {
  handle(request: LodyServiceRequest): Promise<LodyServiceResponse>;
  /** Answers every held request, forgets drafts, and closes the driver. */
  close(): void;
}

export interface LodyServiceOptions {
  /** the first revision is one past this; default the clock's milliseconds */
  seed?: number;
  /** a page of items is cut from its oldest end to fit this many bytes */
  pageBytes?: number;
  /** a draft nobody sent is forgotten after this long */
  draftTtlMs?: number;
  /** a /sync answers within this long (default SYNC_ANSWER_MS) */
  answerMs?: number;
  now?: () => number;
}

export const SYNC_WAIT_MAX_S = 25;
/** A /sync answers within this long of arriving, whatever the driver is doing:
 *  Omarchy Pocket's daemon gives a service request 32 s, and the device's CLI
 *  takes 13 s for a session list and 20 s for a session's history, one after
 *  the other on a cold start. What the driver brings later is the next sync's. */
export const SYNC_ANSWER_MS = 24_000;
export const PAGE_DEFAULT = 40;
export const PAGE_MAX = 200;
export const MENTIONS_MAX = 12;
const PAGE_BYTES = 96 * 1024;
const DRAFT_TTL_MS = 30 * 60_000;
const DRAFT_PART_BYTES = 64 * 1024;
const DRAFT_BYTES = 1024 * 1024;
const DRAFTS_MAX = 64;
/** the status of a request its sender gave up on */
const CANCELLED = 499;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(status: number, value: unknown): LodyServiceResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: encoder.encode(JSON.stringify(value)) };
}

const fail = (status: number, error: string) => json(status, { ok: false, error } satisfies ActionResponse);

/** A refusal with its status, thrown inside a route. */
class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// One session's items, numbered.
// ---------------------------------------------------------------------------

interface Held {
  item: Item;
  json: string;
  rev: number;
}

/** What was last answered for one session, with the revision of every part.
 *  `remote.ts` keeps one per session too, to send a far driver's transcript
 *  as increments. */
export class TranscriptLedger {
  rev = 0;
  order: string[] = [];
  readonly items = new Map<string, Held>();
  /** the session is not in the workspace */
  gone = false;
  complete = true;
  private head = "";
  private state: Pick<BackendTranscript, "state" | "can" | "activeTurn"> = { state: "idle", can: { send: false, cancel: false, answer: false } };
  /** the oldest item given out */
  private windowStart?: string;

  /** Takes what the driver holds now. True when anything differs; `next`
   *  is asked for a revision only then. */
  absorb(now: BackendTranscript | null, next: () => number): boolean {
    if (!now) {
      if (this.gone) return false;
      this.gone = true;
      this.rev = next();
      return true;
    }
    const order: string[] = [];
    const changed: Held[] = [];
    const seen = new Set<string>();
    for (const item of now.items) {
      if (seen.has(item.id)) continue; // a driver's duplicate id: the first stands
      seen.add(item.id);
      order.push(item.id);
      const held = this.items.get(item.id);
      if (held && held.item === item) continue;
      const text = JSON.stringify(item);
      if (held && held.json === text) {
        held.item = item;
        continue;
      }
      const fresh: Held = held ?? { item, json: text, rev: 0 };
      fresh.item = item;
      fresh.json = text;
      if (!held) this.items.set(item.id, fresh);
      changed.push(fresh);
    }
    let differs = changed.length > 0 || this.gone;
    if (this.items.size !== order.length) {
      for (const id of [...this.items.keys()]) if (!seen.has(id)) this.items.delete(id);
      differs = true;
    }
    if (!differs && (order.length !== this.order.length || order.some((id, at) => id !== this.order[at]))) differs = true;
    const head = JSON.stringify([now.state, now.can, now.activeTurn ?? null, now.complete]);
    if (head !== this.head) differs = true;
    this.order = order;
    this.head = head;
    this.state = { state: now.state, can: now.can, ...(now.activeTurn ? { activeTurn: now.activeTurn } : {}) };
    this.complete = now.complete;
    this.gone = false;
    if (!differs) return false;
    this.rev = next();
    for (const held of changed) held.rev = this.rev;
    return true;
  }

  private windowAt(): number {
    const at = this.windowStart === undefined ? -1 : this.order.indexOf(this.windowStart);
    if (at >= 0) return at;
    const start = Math.max(0, this.order.length - PAGE_DEFAULT);
    this.windowStart = this.order[start];
    return start;
  }

  private widen(start: number) {
    const at = this.windowStart === undefined ? -1 : this.order.indexOf(this.windowStart);
    if (at < 0 || start < at) this.windowStart = this.order[start];
  }

  private base(sessionId: string): Omit<Transcript, "older" | "items" | "order"> {
    return { sessionId, rev: this.rev, ...this.state };
  }

  /** `limit` items ending before `before` (the newest when absent), oldest
   *  first, cut from the oldest end to `bytes`. Null when `before` is not held. */
  page(sessionId: string, limit: number, bytes: number, before?: string): Transcript | null {
    let end = this.order.length;
    if (before !== undefined) {
      end = this.order.indexOf(before);
      if (end < 0) return null;
    }
    let start = Math.max(0, end - limit);
    let size = 0;
    for (let at = end - 1; at >= start; at--) {
      size += this.items.get(this.order[at]!)!.json.length + 1;
      // one item always goes, however large
      if (size > bytes && at < end - 1) {
        start = at + 1;
        break;
      }
    }
    if (end > start) this.widen(start);
    const items = this.order.slice(start, end).map((id) => this.items.get(id)!.item);
    return { ...this.base(sessionId), older: start > 0 || !this.complete, items };
  }

  /** The window's items newer than `since`, and the window's ids. */
  since(sessionId: string, since: number): Transcript {
    const start = this.windowAt();
    const order = this.order.slice(start);
    // a revision this ledger never gave (another life of the service): everything
    const from = since > this.rev ? -1 : since;
    const items = order.map((id) => this.items.get(id)!).filter((held) => held.rev > from).map((held) => held.item);
    return { ...this.base(sessionId), older: start > 0 || !this.complete, items, order };
  }

  /** Every held item newer than `since` and every id: the whole session, for `remote.ts`. */
  all(since: number): { rev: number; items: Item[]; order: string[] } {
    const from = since > this.rev ? -1 : since;
    return { rev: this.rev, items: this.order.map((id) => this.items.get(id)!).filter((held) => held.rev > from).map((held) => held.item), order: this.order };
  }

  get held(): number {
    return this.order.length;
  }
}

// ---------------------------------------------------------------------------
// What an @ can name, best first.
// ---------------------------------------------------------------------------

const WORD_BREAK = /[\s/\\\-_.:,()[\]]+/;

function mentionScore(row: MentionRow, query: string): number {
  if (!query) return 1;
  const label = row.label.toLowerCase();
  if (label === query) return 120;
  if (label.startsWith(query)) return 100;
  if (label.split(WORD_BREAK).some((word) => word.startsWith(query))) return 80;
  if (label.includes(query)) return 60;
  const id = row.id.toLowerCase();
  // a path or an id names it when the label does not
  if (row.kind !== "session" && id.includes(query)) return id.startsWith(query) ? 55 : 50;
  if (row.detail?.toLowerCase().includes(query)) return 40;
  // the letters in order, closer together is better
  let at = -1;
  let first = -1;
  for (const letter of query) {
    at = label.indexOf(letter, at + 1);
    if (at < 0) return 0;
    if (first < 0) first = at;
  }
  const spread = at - first + 1 - query.length;
  return Math.max(1, 20 - spread);
}

const KIND_ORDER: Record<MentionRow["kind"], number> = { session: 0, role: 1, file: 2 };

/** `rows` that match `query`, best first, at most `limit`. Rows that score
 *  the same keep the order they came in, sessions before roles before files. */
export function rankMentions(rows: MentionRow[], query: string, limit = MENTIONS_MAX): MentionRow[] {
  const wanted = query.trim().toLowerCase();
  return rows
    .map((row, at) => ({ row, at, score: mentionScore(row, wanted) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] || a.at - b.at)
    .slice(0, limit)
    .map((entry) => entry.row);
}

function sessionMentions(sessions: SessionRow[], except?: string): MentionRow[] {
  return sessions
    .filter((row) => row.id !== except && !row.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((row) => ({ kind: "session" as const, id: row.id, label: row.title || "Untitled", ...(row.project ? { detail: row.project } : {}) }));
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

interface Draft {
  parts: Map<number, string>;
  bytes: number;
  at: number;
}

export function createLodyService(backend: LodyBackend, options: LodyServiceOptions = {}): LodyService {
  const now = options.now ?? Date.now;
  const pageBytes = options.pageBytes ?? PAGE_BYTES;
  const draftTtl = options.draftTtlMs ?? DRAFT_TTL_MS;
  const answerMs = options.answerMs ?? SYNC_ANSWER_MS;
  let counter = options.seed ?? now();
  const next = () => ++counter;
  let closed = false;

  // --- the snapshot ---------------------------------------------------------
  let snapshot: Snapshot | undefined;
  let snapshotJson = "";
  let snapshotDirty = true;
  let snapshotPull: Promise<Snapshot> | undefined;

  function currentSnapshot(): Promise<Snapshot> {
    if (snapshot && !snapshotDirty) return Promise.resolve(snapshot);
    snapshotPull ??= (async () => {
      try {
        snapshotDirty = false;
        const fresh = await backend.snapshot();
        const text = JSON.stringify(fresh);
        if (!snapshot || text !== snapshotJson) {
          snapshotJson = text;
          snapshot = { rev: next(), ...fresh };
          // a sync that answered before this pull came back is waiting for it
          wake();
        }
        return snapshot;
      } catch (error) {
        snapshotDirty = true;
        throw error;
      } finally {
        snapshotPull = undefined;
      }
    })();
    return snapshotPull;
  }

  // --- transcripts ----------------------------------------------------------
  const ledgers = new Map<string, TranscriptLedger>();
  const dirty = new Set<string>();
  const pulls = new Map<string, Promise<TranscriptLedger>>();

  function currentLedger(sessionId: string, force = false): Promise<TranscriptLedger> {
    const held = ledgers.get(sessionId);
    if (held && !force && !dirty.has(sessionId)) return Promise.resolve(held);
    let pull = pulls.get(sessionId);
    if (!pull) {
      pull = (async () => {
        try {
          dirty.delete(sessionId);
          const ledger = ledgers.get(sessionId) ?? new TranscriptLedger();
          const before = ledger.rev;
          ledger.absorb(await backend.transcript(sessionId), next);
          // a session that never was is not remembered
          if (ledger.gone && !ledgers.has(sessionId)) return ledger;
          ledgers.set(sessionId, ledger);
          if (ledger.rev !== before) wake();
          return ledger;
        } catch (error) {
          dirty.add(sessionId);
          throw error;
        } finally {
          pulls.delete(sessionId);
        }
      })();
      pulls.set(sessionId, pull);
    }
    return pull;
  }

  // --- waiting for a change -------------------------------------------------
  const waiters = new Set<() => void>();
  /** changes so far: a sync notes it before a look, and a change between the look and its wait is not missed */
  let changes = 0;
  const wake = () => {
    changes++;
    for (const waiter of [...waiters]) waiter();
  };
  const unsubscribe = backend.subscribe((change: BackendChange) => {
    if (change.kind === "snapshot") snapshotDirty = true;
    else if (ledgers.has(change.id) || pulls.has(change.id)) dirty.add(change.id);
    wake();
  });

  /** `pull`'s value, or, when it is not back by `by`, `held` (undefined: nothing is held yet). A pull that loses keeps running and is the next look's. */
  function heldBy<T>(pull: Promise<T>, by: number, held: T | undefined): Promise<T | undefined> {
    const left = by - now();
    if (left <= 0) {
      pull.catch(() => {});
      return Promise.resolve(held);
    }
    return new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        pull.catch(() => {});
        resolve(held);
      }, left);
      pull.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Resolves at a change after the `seen`th, after `ms`, or when `signal` aborts. */
  function changeWithin(ms: number, signal?: AbortSignal, seen = changes): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted || closed || changes !== seen) return resolve();
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  // --- drafts ---------------------------------------------------------------
  const drafts = new Map<string, Draft>();

  function sweepDrafts() {
    const cutoff = now() - draftTtl;
    for (const [id, draft] of drafts) if (draft.at < cutoff) drafts.delete(id);
  }

  function putDraft(query: URLSearchParams, body: Uint8Array): ActionResponse {
    const id = query.get("id") ?? "";
    const part = Number(query.get("part"));
    if (!id || id.length > 64) throw new Refusal(400, "A draft part needs ?id=<draft id>, at most 64 characters.");
    if (!Number.isInteger(part) || part < 0 || part > 4095) throw new Refusal(400, "A draft part needs ?part=<n>, a whole number from 0 to 4095.");
    if (body.length > DRAFT_PART_BYTES) throw new Refusal(413, "That part of the message is too long; send it in smaller parts.");
    sweepDrafts();
    let draft = drafts.get(id);
    if (!draft) {
      if (drafts.size >= DRAFTS_MAX) drafts.delete(drafts.keys().next().value!);
      draft = { parts: new Map(), bytes: 0, at: now() };
      drafts.set(id, draft);
    }
    const text = decoder.decode(body);
    draft.bytes += body.length - encoder.encode(draft.parts.get(part) ?? "").length;
    if (draft.bytes > DRAFT_BYTES) {
      drafts.delete(id);
      throw new Refusal(413, "That message is longer than the bridge takes (1 MiB); shorten it and send it again.");
    }
    draft.parts.set(part, text);
    draft.at = now();
    return { ok: true };
  }

  /** `text` followed by the draft's parts in order. */
  function joined(text: unknown, draftId: unknown): string {
    let out = typeof text === "string" ? text : "";
    if (draftId === undefined || draftId === null || draftId === "") return out;
    sweepDrafts();
    const draft = typeof draftId === "string" ? drafts.get(draftId) : undefined;
    if (!draft) throw new Refusal(409, "The long message's parts are no longer on the bridge; send the message again.");
    const numbers = [...draft.parts.keys()].sort((a, b) => a - b);
    const first = numbers[0]!;
    if (first > 1) throw new Refusal(409, `Part ${first - 1} of the message did not arrive; send the message again.`);
    for (let at = 0; at < numbers.length; at++) {
      if (numbers[at] !== first + at) throw new Refusal(409, `Part ${first + at} of the message did not arrive; send the message again.`);
      out += draft.parts.get(numbers[at]!)!;
    }
    return out;
  }

  // --- routes ---------------------------------------------------------------
  function whole(query: URLSearchParams, name: string): number | undefined {
    const raw = query.get(name);
    if (raw === null || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Refusal(400, `?${name}= takes a number.`);
    return Math.trunc(value);
  }

  /** The newest page. A request that named revision 0 holds nothing: it gets
   *  the page too, with the page's ids as its `order`. */
  function newest(ledger: TranscriptLedger, sessionId: string, limit: number, ordered: boolean): Transcript {
    const page = ledger.page(sessionId, limit, pageBytes)!;
    return ordered ? { ...page, order: page.items.map((item) => item.id) } : page;
  }

  async function sync(request: LodyServiceRequest): Promise<LodyServiceResponse> {
    const { query, signal } = request;
    const rev = whole(query, "rev");
    const sessionId = query.get("session") || undefined;
    const srev = whole(query, "srev");
    const waitRaw = Number(query.get("wait") ?? 0);
    const waitMs = Number.isFinite(waitRaw) ? Math.min(SYNC_WAIT_MAX_S, Math.max(0, waitRaw)) * 1000 : 0;
    const arrived = now();
    const deadline = arrived + Math.min(waitMs, answerMs);
    const answerBy = arrived + answerMs;
    // the first look asks the driver even when nothing was reported: a driver
    // refreshes a session more often while someone has it open
    for (let look = 0; ; look++) {
      const seen = changes;
      // what the driver has not brought by the time to answer stays its own: the answer carries what is held
      const current = await heldBy(currentSnapshot(), answerBy, snapshot);
      const out: SyncResponse = { protocol: PROTOCOL, rev: current?.rev ?? rev ?? 0 };
      if (current && current.rev !== rev) out.snapshot = current;
      if (sessionId) {
        const ledger = await heldBy(currentLedger(sessionId, look === 0), answerBy, ledgers.get(sessionId));
        if (ledger && !ledger.gone) {
          if (srev === undefined || srev <= 0) out.transcript = newest(ledger, sessionId, PAGE_DEFAULT, srev !== undefined);
          else if (ledger.rev !== srev) out.transcript = ledger.since(sessionId, srev);
        }
      }
      const left = deadline - now();
      if (out.snapshot || out.transcript || left <= 0 || closed) return json(200, out);
      if (signal?.aborted) return fail(CANCELLED, "The request was cancelled.");
      await changeWithin(left, signal, seen);
      if (signal?.aborted) return fail(CANCELLED, "The request was cancelled.");
    }
  }

  async function session(query: URLSearchParams): Promise<LodyServiceResponse> {
    const id = query.get("id");
    if (!id) throw new Refusal(400, "Name the session to open: /session needs ?id=<session id>.");
    const limit = Math.min(PAGE_MAX, Math.max(1, whole(query, "limit") ?? PAGE_DEFAULT));
    const before = query.get("before") || undefined;
    const rev = whole(query, "rev");
    let ledger = await currentLedger(id, true);
    if (ledger.gone) throw new Refusal(404, "That session is not in this workspace any more; go back and pick another.");
    if (rev !== undefined && rev > 0 && before === undefined) return json(200, ledger.since(id, rev));
    // the page reaches past what the driver holds: ask it for more, once
    const end = before === undefined ? ledger.held : ledger.order.indexOf(before);
    if (end >= 0 && end < limit && !ledger.complete && (await backend.older(id))) ledger = await currentLedger(id, true);
    if (before === undefined) return json(200, newest(ledger, id, limit, rev !== undefined));
    const page = ledger.page(id, limit, pageBytes, before);
    if (!page) throw new Refusal(404, "That message is no longer in the conversation; open the session again.");
    return json(200, page);
  }

  async function mentions(query: URLSearchParams): Promise<LodyServiceResponse> {
    const text = query.get("q") ?? "";
    const sessionId = query.get("session") || undefined;
    const kind = query.get("kind") || undefined;
    if (kind !== undefined && kind !== "session" && kind !== "file" && kind !== "role") throw new Refusal(400, "?kind= is session, file or role.");
    const rows: MentionRow[] = [];
    if (!kind || kind === "session") rows.push(...sessionMentions((await currentSnapshot()).sessions, sessionId));
    if (kind !== "session") {
      const more = await backend.mentions({ text, ...(sessionId ? { session: sessionId } : {}), ...(kind ? { kind } : {}) });
      rows.push(...more.filter((row) => row.kind !== "session" && (!kind || row.kind === kind)));
    }
    return json(200, rankMentions(rows, text));
  }

  function body<T>(request: LodyServiceRequest): T {
    if (request.body.length === 0) return {} as T;
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(request.body));
    } catch {
      throw new Refusal(400, "The request's body is not JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Refusal(400, "The request's body must be a JSON object.");
    return value as T;
  }

  function text(value: unknown, sentence: string): string {
    if (typeof value !== "string" || !value) throw new Refusal(400, sentence);
    return value;
  }

  const answered = (result: ActionResponse) => json(result.ok ? 200 : 409, result.ok ? result : { ...result, ok: false, error: result.error || "Lody refused that, and did not say why." });

  async function action(path: string, request: LodyServiceRequest): Promise<LodyServiceResponse> {
    switch (path) {
      case "/draft":
        return json(200, putDraft(request.query, request.body));
      case "/send": {
        const input = body<SendRequest>(request);
        const sessionId = text(input.session, "Name the session the message is for.");
        const message = joined(input.text, input.draft);
        if (!message.trim()) throw new Refusal(400, "Write a message before sending it.");
        const mentioned = Array.isArray(input.mentions) ? input.mentions.filter((m) => m && Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= 0 && m.end > m.start && m.end <= message.length && typeof m.id === "string") : [];
        const result = await backend.send({ session: sessionId, text: message, ...(mentioned.length ? { mentions: mentioned } : {}), ...(input.steer ? { steer: true } : {}) });
        if (result.ok && typeof input.draft === "string") drafts.delete(input.draft);
        return answered(result);
      }
      case "/create": {
        const input = body<CreateRequest>(request);
        const machine = text(input.machine, "Pick the computer the session runs on.");
        const agent = text(input.agent, "Pick the agent the session runs.");
        const message = joined(input.text, input.draft);
        if (!message.trim()) throw new Refusal(400, "Write the session's first message before starting it.");
        const result = await backend.create({
          machine,
          agent,
          text: message,
          ...(typeof input.workspace === "string" && input.workspace ? { workspace: input.workspace } : {}),
          ...(typeof input.project === "string" && input.project ? { project: input.project } : {}),
          ...(typeof input.branch === "string" && input.branch ? { branch: input.branch } : {}),
          ...(input.worktree ? { worktree: true } : {}),
          ...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim().slice(0, 200) } : {}),
        });
        if (result.ok && typeof input.draft === "string") drafts.delete(input.draft);
        return answered(result);
      }
      case "/cancel":
        return answered(await backend.cancel(text(body<{ session?: string }>(request).session, "Name the session to stop.")));
      case "/answer": {
        const input = body<{ session?: string; requestId?: string; option?: string; text?: string }>(request);
        return answered(
          await backend.answer({
            session: text(input.session, "Name the session the answer is for."),
            requestId: text(input.requestId, "Name the request being answered."),
            option: text(input.option, "Pick one of the request's options."),
            ...(typeof input.text === "string" && input.text ? { text: input.text } : {}),
          }),
        );
      }
      case "/archive": {
        const input = body<{ session?: string; archived?: boolean }>(request);
        return answered(await backend.archive(text(input.session, "Name the session to archive."), input.archived !== false));
      }
      case "/rename": {
        const input = body<{ session?: string; title?: string }>(request);
        const sessionId = text(input.session, "Name the session to rename.");
        const title = typeof input.title === "string" ? input.title.trim() : "";
        if (!title) throw new Refusal(400, "A session's title cannot be empty.");
        if (title.length > 200) throw new Refusal(400, "A session's title is at most 200 characters.");
        return answered(await backend.rename(sessionId, title));
      }
      case "/read":
        return answered(await backend.read(text(body<{ session?: string }>(request).session, "Name the session that was read.")));
      case "/workspace":
        return answered(await backend.workspace(text(body<{ id?: string }>(request).id, "Name the workspace to switch to.")));
      case "/signin":
        return answered(await backend.signin());
      case "/setup":
        return answered(backend.setup ? await backend.setup() : { ok: false, error: "This bridge has nothing to set up." });
      case "/signout":
        return answered(await backend.signout());
    }
    throw new Refusal(404, `The bridge has no route POST ${path}.`);
  }

  const GETS = new Set(["/sync", "/session", "/mentions", "/options"]);
  const POSTS = new Set(["/draft", "/send", "/create", "/cancel", "/answer", "/archive", "/rename", "/read", "/workspace", "/signin", "/signout", "/setup"]);

  async function handle(request: LodyServiceRequest): Promise<LodyServiceResponse> {
    const method = request.method.toUpperCase();
    const path = request.path.length > 1 ? request.path.replace(/\/+$/, "") : request.path;
    try {
      if (closed) return fail(503, "The bridge is shutting down; try again in a moment.");
      if (GETS.has(path)) {
        if (method !== "GET") return fail(405, `${path} is read with GET.`);
        if (path === "/sync") return await sync(request);
        if (path === "/session") return await session(request.query);
        if (path === "/mentions") return await mentions(request.query);
        return json(200, await backend.options(request.query.get("machine") || undefined));
      }
      if (POSTS.has(path)) {
        if (method !== "POST") return fail(405, `${path} is sent with POST.`);
        return await action(path, request);
      }
      return fail(404, `The bridge has no route ${method} ${path}.`);
    } catch (error) {
      if (error instanceof Refusal) return fail(error.status, error.message);
      if (request.signal?.aborted) return fail(CANCELLED, "The request was cancelled.");
      const reason = error instanceof Error ? error.message : String(error);
      return fail(502, `The bridge could not finish that: ${reason.slice(0, 300)}`);
    }
  }

  return {
    handle,
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      wake();
      drafts.clear();
      backend.close();
    },
  };
}
