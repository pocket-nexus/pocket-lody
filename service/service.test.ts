// The service's routes over the fixture driver.
import { afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL, type ActionResponse, type CreateOptions, type Item, type MentionRow, type SyncResponse, type Transcript } from "../protocol.ts";
import { createFixtureBackend, FIXTURE_TURN_MS, type FixtureBackend } from "./fixture.ts";
import { createLodyService, rankMentions, type LodyService } from "./service.ts";

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let service: LodyService;
let fixture: FixtureBackend;

function setup(options: { pageBytes?: number; start?: "setup" | "signed-out"; machine?: string } = {}) {
  const { start, machine, ...rest } = options;
  fixture = createFixtureBackend({ now: NOW, ...(start ? { start } : {}), ...(machine ? { machine } : {}) });
  service = createLodyService(fixture, { seed: 1000, ...rest });
}

afterEach(() => service?.close());

async function get<T>(path: string, query: Record<string, string | number> = {}, signal?: AbortSignal): Promise<{ status: number; body: T; bytes: number }> {
  const response = await service.handle({ method: "GET", path, query: new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string])), body: new Uint8Array(0), ...(signal ? { signal } : {}) });
  return { status: response.status, body: JSON.parse(decoder.decode(response.body)) as T, bytes: response.body.length };
}

async function post<T = ActionResponse>(path: string, body: unknown = {}, query: Record<string, string | number> = {}): Promise<{ status: number; body: T }> {
  const bytes = typeof body === "string" ? encoder.encode(body) : encoder.encode(JSON.stringify(body));
  const response = await service.handle({ method: "POST", path, query: new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string])), body: bytes });
  return { status: response.status, body: JSON.parse(decoder.decode(response.body)) as T };
}

/** What an applet does with an increment: merge by id, keep `order`. */
function merge(held: Map<string, Item>, transcript: Transcript): Item[] {
  for (const item of transcript.items) held.set(item.id, item);
  if (!transcript.order) return transcript.items;
  for (const id of [...held.keys()]) if (!transcript.order.includes(id)) held.delete(id);
  return transcript.order.map((id) => held.get(id)!);
}

describe("sync", () => {
  test("the first sync carries the whole workspace", async () => {
    setup();
    const { status, body, bytes } = await get<SyncResponse>("/sync", { rev: 0 });
    expect(status).toBe(200);
    expect(body.protocol).toBe(PROTOCOL);
    expect(body.rev).toBeGreaterThan(1000);
    const snapshot = body.snapshot!;
    expect(snapshot.rev).toBe(body.rev);
    expect(snapshot.link).toMatchObject({ phase: "ready", driver: "fixture", user: { name: "林夏" } });
    expect(snapshot.workspaces).toHaveLength(2);
    expect(snapshot.workspaceId).toBe("ws-lantern");
    expect(snapshot.machines.filter((machine) => !machine.online)).toHaveLength(1);
    expect(snapshot.sessions.length).toBeGreaterThanOrEqual(14);
    expect(new Set(snapshot.sessions.map((row) => row.state))).toEqual(new Set(["idle", "starting", "running", "waiting", "failed"]));
    expect(snapshot.sessions.some((row) => row.unread)).toBe(true);
    expect(snapshot.sessions.some((row) => row.prs?.length)).toBe(true);
    expect(snapshot.sessions.filter((row) => row.parentId === "s-parent")).toHaveLength(2);
    expect(snapshot.sessions.some((row) => row.openedById === "s-parent")).toBe(true);
    expect(bytes).toBeLessThan(64 * 1024);
  });

  test("a sync at the current revision answers nothing new, at once without wait", async () => {
    setup();
    const first = await get<SyncResponse>("/sync", { rev: 0 });
    const started = Date.now();
    const again = await get<SyncResponse>("/sync", { rev: first.body.rev });
    expect(again.body).toEqual({ protocol: PROTOCOL, rev: first.body.rev });
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("a held sync is answered when the workspace changes", async () => {
    setup();
    const { body } = await get<SyncResponse>("/sync", { rev: 0 });
    const started = Date.now();
    const held = get<SyncResponse>("/sync", { rev: body.rev, wait: 10 });
    setTimeout(() => void post("/rename", { session: "s-chat", title: "Lifetimes" }), 40);
    const answered = await held;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answered.body.rev).toBeGreaterThan(body.rev);
    expect(answered.body.snapshot!.sessions.find((row) => row.id === "s-chat")!.title).toBe("Lifetimes");
  });

  test("a held sync is answered with the same revisions when wait runs out", async () => {
    setup();
    const { body } = await get<SyncResponse>("/sync", { rev: 0 });
    const started = Date.now();
    const answered = await get<SyncResponse>("/sync", { rev: body.rev, wait: 0.15 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(answered.body).toEqual({ protocol: PROTOCOL, rev: body.rev });
  });

  test("an aborted sync ends without waiting out its time", async () => {
    setup();
    const { body } = await get<SyncResponse>("/sync", { rev: 0 });
    const abort = new AbortController();
    const started = Date.now();
    const held = get<ActionResponse>("/sync", { rev: body.rev, wait: 20 }, abort.signal);
    setTimeout(() => abort.abort(), 30);
    const answered = await held;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(answered.status).toBe(499);
    expect(answered.body.ok).toBe(false);
  });

  test("closing the service answers what it holds", async () => {
    setup();
    const { body } = await get<SyncResponse>("/sync", { rev: 0 });
    const held = get<SyncResponse>("/sync", { rev: body.rev, wait: 20 });
    setTimeout(() => service.close(), 20);
    expect((await held).status).toBe(200);
  });

  test("a sync that names a session carries its transcript when it is behind", async () => {
    setup();
    const opened = await get<Transcript>("/session", { id: "s-chat" });
    const base = await get<SyncResponse>("/sync", { rev: 0 });
    const quiet = await get<SyncResponse>("/sync", { rev: base.body.rev, session: "s-chat", srev: opened.body.rev });
    expect(quiet.body.transcript).toBeUndefined();
    const held = get<SyncResponse>("/sync", { rev: base.body.rev, session: "s-chat", srev: opened.body.rev, wait: 10 });
    setTimeout(() => void post("/send", { session: "s-chat", text: "one more question" }), 30);
    const answered = await held;
    const transcript = answered.body.transcript!;
    expect(transcript.rev).toBeGreaterThan(opened.body.rev);
    expect(transcript.items).toHaveLength(1);
    expect(transcript.items[0]).toMatchObject({ k: "user", text: "one more question", delivery: "sending" });
    expect(transcript.order).toEqual([...opened.body.items.map((item) => item.id), transcript.items[0]!.id]);
  });

  test("revisions only grow", async () => {
    setup();
    const seen: number[] = [];
    let rev = 0;
    for (let step = 0; step < 6; step++) {
      await post("/rename", { session: "s-chat", title: `title ${step}` });
      const { body } = await get<SyncResponse>("/sync", { rev });
      seen.push(body.rev);
      rev = body.rev;
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("a slow driver", () => {
  // The device's CLI takes 13 s for a session list and 20 s for a history,
  // and Omarchy Pocket's daemon gives a request 32 s: a sync answers by its
  // budget with what is held, and what the driver brings later wakes the next.
  test("a sync answers by its budget with what is held, and the late snapshot is the next sync's", async () => {
    fixture = createFixtureBackend({ now: NOW });
    let slow = false;
    const snapshot = fixture.snapshot.bind(fixture);
    const backend = Object.assign(Object.create(fixture), {
      snapshot: async () => {
        const value = await snapshot();
        if (slow) await new Promise((done) => setTimeout(done, 300));
        return value;
      },
    });
    service = createLodyService(backend, { seed: 1000, answerMs: 100 });
    const first = await get<SyncResponse>("/sync", { rev: 0 });
    expect(first.body.snapshot?.sessions.length).toBeGreaterThan(0);
    // a change is reported, and the driver is slow to bring it
    slow = true;
    await post("/read", { session: first.body.snapshot!.sessions[0]!.id });
    const started = Date.now();
    const held = await get<SyncResponse>("/sync", { rev: first.body.rev, wait: 20 });
    expect(Date.now() - started).toBeLessThan(250);
    expect(held.status).toBe(200);
    // the pull kept running: the next sync has it without asking the driver again
    slow = false;
    await new Promise((done) => setTimeout(done, 350));
    const after = await get<SyncResponse>("/sync", { rev: held.body.rev, wait: 0 });
    expect(after.status).toBe(200);
  });

  test("a sync with nothing held yet answers by its budget without a snapshot", async () => {
    fixture = createFixtureBackend({ now: NOW });
    const backend = Object.assign(Object.create(fixture), { snapshot: () => new Promise(() => {}) });
    service = createLodyService(backend, { seed: 1000, answerMs: 50 });
    const started = Date.now();
    const answer = await get<SyncResponse>("/sync", { rev: 0 });
    expect(Date.now() - started).toBeLessThan(200);
    expect(answer.status).toBe(200);
    expect(answer.body.snapshot).toBeUndefined();
  });
});

describe("a transcript", () => {
  test("opens on its newest page and pages back to the start", async () => {
    setup();
    const newest = await get<Transcript>("/session", { id: "s-long" });
    expect(newest.status).toBe(200);
    expect(newest.body.items).toHaveLength(40);
    expect(newest.body.older).toBe(true);
    expect(newest.body.order).toBeUndefined();
    expect(newest.body.can).toEqual({ send: true, cancel: false, answer: false });

    const all: Item[] = [...newest.body.items];
    let older = newest.body.older;
    let pages = 1;
    while (older) {
      const page = await get<Transcript>("/session", { id: "s-long", before: all[0]!.id, limit: 50 });
      expect(page.body.items.length).toBeGreaterThan(0);
      expect(page.body.items.length).toBeLessThanOrEqual(50);
      all.unshift(...page.body.items);
      older = page.body.older;
      pages++;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(all.length).toBeGreaterThanOrEqual(120);
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    expect(all.map((item) => item.at)).toEqual([...all.map((item) => item.at)].sort((a, b) => a - b));
    expect(all).toEqual((await fixture.transcript("s-long"))!.items);
  });

  test("a page is cut to its byte budget from the oldest end", async () => {
    setup({ pageBytes: 4000 });
    const page = await get<Transcript>("/session", { id: "s-long", limit: 200 });
    expect(page.bytes).toBeLessThan(4600);
    expect(page.body.items.length).toBeLessThan(40);
    expect(page.body.older).toBe(true);
    const all = (await fixture.transcript("s-long"))!.items;
    expect(page.body.items).toEqual(all.slice(-page.body.items.length));
  });

  test("every kind of item is in the sample workspace", async () => {
    setup();
    const kinds = new Set<string>();
    const tools = new Set<string>();
    const statuses = new Set<string>();
    let chinese = 0;
    const { body } = await get<SyncResponse>("/sync", { rev: 0 });
    for (const row of body.snapshot!.sessions) {
      const items = (await fixture.transcript(row.id))!.items;
      const text = items.map((item) => ("text" in item ? item.text : "")).join("");
      if ((text.match(/[一-鿿]/g) ?? []).length > text.length * 0.2) chinese++;
      for (const item of items) {
        kinds.add(item.k);
        if (item.k === "tool") {
          tools.add(item.kind);
          statuses.add(item.status);
        }
      }
    }
    expect(kinds).toEqual(new Set(["user", "text", "thought", "tool", "ask", "plan", "notice", "turn-end"]));
    expect(tools).toEqual(new Set(["read", "edit", "search", "execute", "fetch", "think", "delegate", "other"]));
    expect(statuses).toEqual(new Set(["pending", "running", "done", "failed"]));
    expect(chinese).toBeGreaterThanOrEqual(4);
  });

  test("increments merged by id reproduce the driver's whole list through a simulated turn", async () => {
    setup();
    const held = new Map<string, Item>();
    const opened = await get<Transcript>("/session", { id: "s-docs", limit: 200 });
    let list = merge(held, opened.body);
    let rev = opened.body.rev;
    expect((await post("/send", { session: "s-docs", text: "再检查一遍链接" })).body).toEqual({ ok: true });
    const states = new Set<string>();
    let streamed = 0;
    for (let elapsed = 0; elapsed <= FIXTURE_TURN_MS + 1000; elapsed += 200) {
      fixture.advance(200);
      const step = await get<Transcript>("/session", { id: "s-docs", rev });
      expect(step.body.rev).toBeGreaterThanOrEqual(rev);
      if (step.body.rev === rev) {
        expect(step.body.items).toHaveLength(0);
        continue;
      }
      rev = step.body.rev;
      states.add(step.body.state);
      if (step.body.items.some((item) => item.k === "text" && item.streaming)) streamed++;
      list = merge(held, step.body);
      expect(list).toEqual((await fixture.transcript("s-docs"))!.items);
    }
    expect(states).toEqual(new Set(["running", "idle"]));
    expect(streamed).toBeGreaterThanOrEqual(3);
    expect(list.at(-1)).toMatchObject({ k: "turn-end", outcome: "completed" });
  });

  test("an increment's order is the window the applet was given", async () => {
    setup();
    const newest = await get<Transcript>("/session", { id: "s-long" });
    await post("/send", { session: "s-long", text: "status?" });
    const step = await get<Transcript>("/session", { id: "s-long", rev: newest.body.rev });
    expect(step.body.order).toEqual([...newest.body.items.map((item) => item.id), step.body.items[0]!.id]);
    expect(step.body.older).toBe(true);
    // paging back widens the window
    const page = await get<Transcript>("/session", { id: "s-long", before: newest.body.items[0]!.id, limit: 10 });
    const after = await get<Transcript>("/session", { id: "s-long", rev: step.body.rev });
    expect(after.body.items).toHaveLength(0);
    expect(after.body.order!.slice(0, 10)).toEqual(page.body.items.map((item) => item.id));
    expect(after.body.order).toHaveLength(51);
  });

  test("revision 0 is an applet that holds nothing: the newest page, cut to the byte budget", async () => {
    setup({ pageBytes: 4000 });
    const plain = await get<Transcript>("/session", { id: "s-long" });
    const zero = await get<Transcript>("/session", { id: "s-long", rev: 0 });
    expect(zero.body.items).toEqual(plain.body.items);
    expect(zero.body.order).toEqual(plain.body.items.map((item) => item.id));
    expect(zero.bytes).toBeLessThan(6000);
    const synced = await get<SyncResponse>("/sync", { rev: 0, session: "s-long", srev: 0 });
    expect(synced.body.transcript!.items).toEqual(plain.body.items);
    expect(synced.body.transcript!.older).toBe(true);
    // and from there on, increments
    await post("/send", { session: "s-long", text: "next" });
    const step = await get<SyncResponse>("/sync", { rev: synced.body.rev, session: "s-long", srev: synced.body.transcript!.rev });
    expect(step.body.transcript!.items).toHaveLength(1);
    expect(step.body.transcript!.order).toEqual([...plain.body.items.map((item) => item.id), step.body.transcript!.items[0]!.id]);
  });

  test("a revision from another life of the service is answered with everything", async () => {
    setup();
    const newest = await get<Transcript>("/session", { id: "s-chat" });
    const ahead = await get<Transcript>("/session", { id: "s-chat", rev: newest.body.rev + 1_000_000 });
    expect(ahead.body.items).toEqual(newest.body.items);
    expect(ahead.body.order).toEqual(newest.body.items.map((item) => item.id));
  });
});

describe("a turn", () => {
  async function watch(session: string, ms: number, step = 100) {
    const seen: { state: string; items: Item[] }[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      fixture.advance(step);
      const now = (await fixture.transcript(session))!;
      seen.push({ state: now.state, items: now.items });
    }
    return seen;
  }

  test("send: the message, then running, a thought, a tool call, text that grows, the end, idle", async () => {
    setup();
    const before = (await fixture.transcript("s-kite-table"))!.items.length;
    expect((await post("/send", { session: "s-kite-table", text: "Also virtualize the customers table" })).body.ok).toBe(true);
    const first = (await fixture.transcript("s-kite-table"))!;
    expect(first.items).toHaveLength(before + 1);
    expect(first.items.at(-1)).toMatchObject({ k: "user", mine: true, delivery: "sending" });
    expect(first.state).toBe("idle");

    const seen = await watch("s-kite-table", FIXTURE_TURN_MS + 400);
    expect(seen.find((entry) => entry.state === "running")).toBeDefined();
    expect(seen.at(-1)!.state).toBe("idle");
    const added = seen.map((entry) => entry.items.slice(before));
    const tool = (items: Item[]) => items.find((item) => item.k === "tool");
    const toolStates = [...new Set(added.map((items) => tool(items)).filter((item) => item?.k === "tool").map((item) => (item!.k === "tool" ? item!.status : "")))];
    expect(toolStates).toEqual(["pending", "running", "done"]);
    const lengths = [...new Set(added.map((items) => items.find((item) => item.k === "text")).filter((item) => item?.k === "text").map((item) => (item!.k === "text" ? item!.text.length : 0)))];
    expect(lengths.length).toBeGreaterThanOrEqual(4);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    const last = added.at(-1)!;
    expect(last.map((item) => item.k)).toEqual(["user", "thought", "tool", "text", "turn-end"]);
    expect(last[0]).not.toHaveProperty("delivery");
    expect(last[3]).toMatchObject({ k: "text", final: true });
    expect(last[3]).not.toHaveProperty("streaming");
    expect(last[4]).toMatchObject({ k: "turn-end", outcome: "completed" });
    expect((last[4] as { durationMs: number }).durationMs).toBeGreaterThan(5000);
    expect(new Set(last.map((item) => item.turn))).toEqual(new Set([last[0]!.id]));
    // the row followed: unread again, its preview the answer
    const row = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!.sessions.find((entry) => entry.id === "s-kite-table")!;
    expect(row.unread).toBe(true);
    expect(row.preview).toContain("customers table");
  });

  test("cancel stops it", async () => {
    setup();
    await post("/send", { session: "s-chat", text: "explain borrow checking at length" });
    await watch("s-chat", 2600);
    const running = await get<Transcript>("/session", { id: "s-chat" });
    expect(running.body.state).toBe("running");
    expect(running.body.can.cancel).toBe(true);
    expect(running.body.activeTurn).toBeDefined();
    expect((await post("/cancel", { session: "s-chat" })).body).toEqual({ ok: true });
    const stopped = await get<Transcript>("/session", { id: "s-chat" });
    expect(stopped.body.state).toBe("idle");
    expect(stopped.body.can.cancel).toBe(false);
    expect(stopped.body.activeTurn).toBeUndefined();
    expect(stopped.body.items.at(-1)).toMatchObject({ k: "turn-end", outcome: "canceled" });
    expect(stopped.body.items.some((item) => (item.k === "text" && item.streaming) || (item.k === "tool" && (item.status === "running" || item.status === "pending")))).toBe(false);
    const count = stopped.body.items.length;
    await watch("s-chat", 10_000, 1000);
    expect((await fixture.transcript("s-chat"))!.items).toHaveLength(count);
    // stopping a session that is not working is not an error
    expect((await post("/cancel", { session: "s-chat" })).body).toEqual({ ok: true });
  });

  test("a message to a working session waits its turn", async () => {
    setup();
    await post("/send", { session: "s-chat", text: "first" });
    await watch("s-chat", 1000);
    await post("/send", { session: "s-chat", text: "second" });
    const queued = (await fixture.transcript("s-chat"))!.items.at(-1)!;
    expect(queued).toMatchObject({ k: "user", text: "second", delivery: "queued" });
    await watch("s-chat", 2 * FIXTURE_TURN_MS + 1000, 500);
    const done = (await fixture.transcript("s-chat"))!;
    expect(done.state).toBe("idle");
    expect(done.items.filter((item) => item.k === "turn-end").slice(-2).map((item) => (item.k === "turn-end" ? item.outcome : ""))).toEqual(["completed", "completed"]);
    expect(done.items.find((item) => item.id === queued.id)).not.toHaveProperty("delivery");
  });

  test("answering a permission resumes the turn", async () => {
    setup();
    const waiting = await get<Transcript>("/session", { id: "s-release" });
    expect(waiting.body.state).toBe("waiting");
    expect(waiting.body.can.answer).toBe(true);
    const ask = waiting.body.items.find((item) => item.k === "ask" && item.outcome === undefined)!;
    if (ask.k !== "ask") throw new Error("no ask");
    expect(ask.options.map((option) => option.kind)).toEqual(["allow", "allow-always", "reject"]);
    expect((await post("/answer", { session: "s-release", requestId: ask.requestId, option: "nope" })).status).toBe(409);
    expect((await post("/answer", { session: "s-release", requestId: ask.requestId, option: "allow" })).body).toEqual({ ok: true });
    const seen = await watch("s-release", 8000);
    expect(seen[5]!.state).toBe("running");
    const done = await get<Transcript>("/session", { id: "s-release", limit: 100 });
    expect(done.body.state).toBe("idle");
    expect(done.body.can.answer).toBe(false);
    expect(done.body.items.find((item) => item.id === ask.id)).toMatchObject({ outcome: "允许一次" });
    expect(done.body.items.find((item) => item.k === "tool" && item.detail === "git push origin v0.9.0")).toMatchObject({ status: "done" });
    expect(done.body.items.at(-1)).toMatchObject({ k: "turn-end", outcome: "completed" });
    const twice = await post("/answer", { session: "s-release", requestId: ask.requestId, option: "allow" });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe("That request was already answered.");
  });

  test("answering a question with one of several options", async () => {
    setup();
    const waiting = await get<Transcript>("/session", { id: "s-schema" });
    const ask = waiting.body.items.find((item) => item.k === "ask")!;
    if (ask.k !== "ask") throw new Error("no ask");
    expect(ask.question).toBe(true);
    expect(ask.options.length).toBeGreaterThanOrEqual(3);
    await post("/answer", { session: "s-schema", requestId: ask.requestId, option: "a", text: "先在预发试" });
    await watch("s-schema", 5000);
    const done = (await fixture.transcript("s-schema"))!;
    expect(done.state).toBe("idle");
    expect(done.items.find((item) => item.id === ask.id)).toMatchObject({ outcome: "A：按月 RANGE (created_at): 先在预发试" });
    expect(done.items.at(-2)).toMatchObject({ k: "text", final: true });
  });

  test("a message that needs a permission waits for one, and a rejection is honoured", async () => {
    setup();
    await post("/send", { session: "s-docs", text: "deploy the docs site now" });
    await watch("s-docs", 3000);
    const waiting = (await fixture.transcript("s-docs"))!;
    expect(waiting.state).toBe("waiting");
    const ask = waiting.items.at(-1)!;
    if (ask.k !== "ask") throw new Error("no ask");
    await post("/answer", { session: "s-docs", requestId: ask.requestId, option: "reject" });
    await watch("s-docs", 3000);
    const done = (await fixture.transcript("s-docs"))!;
    expect(done.state).toBe("idle");
    expect(done.items.findLast((item) => item.k === "tool")).toMatchObject({ status: "failed" });
  });

  test("the session that was writing at the start finishes on its own", async () => {
    setup();
    const start = (await fixture.transcript("s-sync-retry"))!;
    expect(start.state).toBe("running");
    const text = start.items.at(-1)!;
    expect(text).toMatchObject({ k: "text", streaming: true });
    await watch("s-sync-retry", 8000, 500);
    const done = (await fixture.transcript("s-sync-retry"))!;
    expect(done.state).toBe("idle");
    const grown = done.items.find((item) => item.id === text.id)!;
    expect(grown).toMatchObject({ k: "text", final: true });
    expect((grown as { text: string }).text.length).toBeGreaterThan((text as { text: string }).text.length + 100);
  });
});

describe("drafts", () => {
  test("a prompt in several parts is joined in order by /send", async () => {
    setup();
    const parts = ["第一部分：" + "长".repeat(300), " second part " + "x".repeat(700), "，最后一部分。"];
    // out of order, as retries may arrive
    expect((await post("/draft", parts[1]!, { id: "d1", part: 1 })).body).toEqual({ ok: true });
    expect((await post("/draft", parts[0]!, { id: "d1", part: 0 })).body).toEqual({ ok: true });
    expect((await post("/draft", parts[2]!, { id: "d1", part: 2 })).body).toEqual({ ok: true });
    expect((await post("/send", { session: "s-chat", draft: "d1" })).body).toEqual({ ok: true });
    expect((await fixture.transcript("s-chat"))!.items.at(-1)).toMatchObject({ k: "user", text: parts.join("") });
    // used once
    const again = await post("/send", { session: "s-chat", draft: "d1" });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("send the message again");
  });

  test("a missing part is named", async () => {
    setup();
    await post("/draft", "a", { id: "d2", part: 0 });
    await post("/draft", "c", { id: "d2", part: 2 });
    const refused = await post("/send", { session: "s-chat", draft: "d2" });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ ok: false, error: "Part 1 of the message did not arrive; send the message again." });
  });

  test("/create joins a draft and starts a session that then works", async () => {
    setup();
    await post("/draft", "Add a --dry-run flag to ", { id: "d3", part: 1 });
    await post("/draft", "the release script.", { id: "d3", part: 2 });
    const made = await post("/create", { machine: "m-studio", agent: "a-claude-studio", project: "gh:lantern-labs/harbor-cli", branch: "feat/dry-run", draft: "d3" });
    expect(made.body.ok).toBe(true);
    const id = made.body.session!;
    const row = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!.sessions.find((entry) => entry.id === id)!;
    expect(row).toMatchObject({ state: "starting", title: "Add a --dry-run flag to the release script.", project: "lantern-labs/harbor-cli", branch: "feat/dry-run", mine: true });
    fixture.advance(FIXTURE_TURN_MS + 2500);
    const done = await get<Transcript>("/session", { id });
    expect(done.body.state).toBe("idle");
    expect(done.body.items[0]).toMatchObject({ k: "user", text: "Add a --dry-run flag to the release script." });
    expect(done.body.items.at(-1)).toMatchObject({ k: "turn-end" });
  });
});

describe("mentions", () => {
  test("best first: a title that starts with the query, then a word that does, then a title that holds it", () => {
    const rows: MentionRow[] = [
      { kind: "session", id: "1", label: "Fix the retry loop" },
      { kind: "session", id: "2", label: "Retry policy for sync" },
      { kind: "session", id: "3", label: "Preretry cleanup" },
      { kind: "file", id: "src/retry.rs", label: "retry.rs", detail: "src" },
      { kind: "session", id: "4", label: "Unrelated" },
      { kind: "role", id: "r", label: "Reviewer", detail: "retry-minded" },
    ];
    expect(rankMentions(rows, "retry").map((row) => row.id)).toEqual(["2", "src/retry.rs", "1", "3", "r"]);
    expect(rankMentions(rows, "RETRY.RS").map((row) => row.id)).toEqual(["src/retry.rs"]);
    // letters in order, nearer together first
    expect(rankMentions(rows, "rpol").map((row) => row.id)).toEqual(["2"]);
    expect(rankMentions(rows, "rtp").map((row) => row.id)).toEqual(["2", "1", "3"]);
    expect(rankMentions(rows, "").map((row) => row.id)).toEqual(["1", "2", "3", "4", "r", "src/retry.rs"]);
    expect(rankMentions(Array.from({ length: 40 }, (_, at) => ({ kind: "session" as const, id: String(at), label: `retry ${at}` })), "re")).toHaveLength(12);
  });

  test("sessions, roles and the session's files, filtered by kind", async () => {
    setup();
    const all = await get<MentionRow[]>("/mentions", { q: "", session: "s-sync-retry" });
    expect(all.body).toHaveLength(12);
    expect(all.body[0]!.kind).toBe("session");
    expect(all.body.some((row) => row.id === "s-sync-retry")).toBe(false);
    const files = await get<MentionRow[]>("/mentions", { q: "retry", session: "s-sync-retry", kind: "file" });
    expect(files.body[0]).toEqual({ kind: "file", id: "crates/engine/src/retry.rs", label: "retry.rs", detail: "crates/engine/src" });
    expect(files.body.every((row) => row.kind === "file")).toBe(true);
    const roles = await get<MentionRow[]>("/mentions", { q: "发布", kind: "role" });
    expect(roles.body.map((row) => row.id)).toEqual(["role-release"]);
    const sessions = await get<MentionRow[]>("/mentions", { q: "plugin", kind: "session" });
    expect(sessions.body.map((row) => row.id)).toEqual(["s-parent", "s-delegated"]);
    expect((await get<ActionResponse>("/mentions", { q: "x", kind: "emoji" })).status).toBe(400);
  });
});

describe("the other routes", () => {
  test("options, for the workspace and for one machine", async () => {
    setup();
    const all = await get<CreateOptions>("/options");
    expect(all.body.machines).toHaveLength(3);
    expect(all.body.agents.length).toBeGreaterThanOrEqual(4);
    expect(new Set(all.body.projects.map((project) => project.kind))).toEqual(new Set(["github", "local", "chat"]));
    const forge = await get<CreateOptions>("/options", { machine: "m-forge" });
    expect(forge.body.agents.every((agent) => agent.machineId === "m-forge")).toBe(true);
    expect(forge.body.projects.some((project) => project.machineId && project.machineId !== "m-forge")).toBe(false);
  });

  test("archive, restore, read, switching workspace", async () => {
    setup();
    const row = async (id: string) => (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!.sessions.find((entry) => entry.id === id);
    expect((await post("/archive", { session: "s-parent", archived: true })).body.ok).toBe(true);
    expect((await row("s-parent"))!.archived).toBe(true);
    expect((await row("s-parent-review"))!.archived).toBe(true);
    await post("/archive", { session: "s-parent", archived: false });
    expect((await row("s-parent"))!.archived).toBe(false);
    expect((await row("s-kite-table"))!.unread).toBe(true);
    await post("/read", { session: "s-kite-table" });
    expect((await row("s-kite-table"))!.unread).toBeFalsy();
    expect((await post("/workspace", { id: "ws-home" })).body.ok).toBe(true);
    const home = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!;
    expect(home.workspaceId).toBe("ws-home");
    expect(home.sessions).toHaveLength(3);
    expect(home.machines).toHaveLength(2);
  });

  test("signing out and in again", async () => {
    setup();
    await post("/signout");
    const out = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!;
    expect(out.link.phase).toBe("signed-out");
    expect(out.sessions).toHaveLength(0);
    expect((await get<ActionResponse>("/session", { id: "s-chat" })).status).toBe(404);
    await post("/signin");
    const during = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!;
    expect(during.link).toMatchObject({ phase: "signing-in", code: "LNTN-4821" });
    expect(during.link.url).toContain("user_code=LNTN-4821");
    fixture.advance(5000);
    const back = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!;
    expect(back.link.phase).toBe("ready");
    expect(back.sessions.length).toBeGreaterThan(10);
  });
});

describe("the way in on a device, as the fixture shows it", () => {
  test("setup, then the sign-in with its code, QR and expiry, then the workspace", async () => {
    setup({ start: "setup", machine: "AYN Thor" });
    const offered = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!;
    expect(offered.link).toMatchObject({ phase: "ready", setup: { state: "needed" } });
    expect(offered.sessions.length).toBeGreaterThan(10);
    expect((await post("/setup")).body.ok).toBe(true);
    expect((await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!.link.setup).toEqual({ state: "running", step: "Starting…" });
    fixture.advance(2000);
    expect((await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!.link.setup).toEqual({ state: "running", step: "Downloading Node (19 of 30 MB)…" });
    fixture.advance(5000);
    const out = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!;
    expect(out.link).toEqual({ driver: "fixture", ownAccount: true, phase: "signed-out", machine: "AYN Thor", detail: "AYN Thor is not signed in to Lody. Sign in to see your sessions." });
    expect(out.sessions).toHaveLength(0);

    await post("/signin");
    const during = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!.link;
    expect(during).toMatchObject({ phase: "signing-in", code: "LNTN-4821", machine: "AYN Thor", expiresAt: fixture.now() + 10 * 60_000 });
    expect(during.qr!.length).toBeGreaterThanOrEqual(29);
    // called off: signed out again, nothing left of the code
    await post("/signout");
    const off = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!.link;
    expect(off.phase).toBe("signed-out");
    expect(off.code).toBeUndefined();
    expect(off.qr).toBeUndefined();
    fixture.advance(10_000);
    expect((await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!.link.phase).toBe("signed-out");

    await post("/signin");
    fixture.advance(5000);
    const back = (await get<SyncResponse>("/sync", { rev: 0 })).body.snapshot!;
    expect(back.link).toMatchObject({ phase: "ready", ownAccount: true });
    expect(back.sessions.length).toBeGreaterThan(10);
  });
});

describe("refusals are sentences", () => {
  test.each([
    ["GET", "/nothing", {}, 404, "The bridge has no route GET /nothing."],
    ["POST", "/sync", {}, 405, "/sync is read with GET."],
    ["GET", "/send", {}, 405, "/send is sent with POST."],
    ["GET", "/session", {}, 400, "Name the session to open: /session needs ?id=<session id>."],
    ["GET", "/session", { id: "missing" }, 404, "That session is not in this workspace any more; go back and pick another."],
    ["GET", "/session", { id: "s-chat", before: "missing" }, 404, "That message is no longer in the conversation; open the session again."],
    ["GET", "/sync", { rev: "abc" }, 400, "?rev= takes a number."],
  ] as const)("%s %s %j", async (method, path, query, status, error) => {
    setup();
    const response = await service.handle({ method, path, query: new URLSearchParams(query as Record<string, string>), body: new Uint8Array(0) });
    expect(response.status).toBe(status);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(decoder.decode(response.body))).toEqual({ ok: false, error });
  });

  test.each([
    ["/send", { session: "s-chat" }, 400, "Write a message before sending it."],
    ["/send", { text: "hi" }, 400, "Name the session the message is for."],
    ["/send", { session: "s-air", text: "hi" }, 409, "林夏的 MacBook Air is offline, so the message cannot reach it. Wake that computer, or start a session on another."],
    ["/send", { session: "s-old", text: "hi" }, 409, "This session is archived; restore it before sending to it."],
    ["/send", { session: "s-chat", draft: "never-sent" }, 409, "The long message's parts are no longer on the bridge; send the message again."],
    ["/create", { agent: "a-claude-studio", text: "x" }, 400, "Pick the computer the session runs on."],
    ["/create", { machine: "m-air", agent: "a-claude-air", text: "x" }, 409, "林夏的 MacBook Air is offline; pick another computer or wake it."],
    ["/create", { machine: "m-studio", agent: "a-codex-forge", text: "x" }, 409, "That agent is not set up on Studio Mac; pick one from the list."],
    ["/rename", { session: "s-chat", title: "  " }, 400, "A session's title cannot be empty."],
    ["/answer", { session: "s-release", requestId: "req-release-push" }, 400, "Pick one of the request's options."],
    ["/archive", { session: "s-parent-tests", archived: true }, 409, "Stop the session before archiving it."],
    ["/workspace", { id: "ws-nobody" }, 409, "That workspace is not one you belong to."],
  ] as const)("POST %s %j", async (path, body, status, error) => {
    setup();
    const response = await post(path, body);
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ ok: false, error });
  });

  test("a body that is not JSON, a draft without a part", async () => {
    setup();
    expect((await post("/send", "{not json")).body).toEqual({ ok: false, error: "The request's body is not JSON." });
    expect((await post("/draft", "text", { id: "d" })).body.ok).toBe(true); // part defaults to 0
    expect((await post("/draft", "text", { id: "d", part: -1 })).body.error).toBe("A draft part needs ?part=<n>, a whole number from 0 to 4095.");
    expect((await post("/draft", "text", {})).body.error).toBe("A draft part needs ?id=<draft id>, at most 64 characters.");
  });

  test("a driver that throws is a 502 with its reason", async () => {
    setup();
    fixture.transcript = async () => {
      throw new Error("the disk is full");
    };
    const response = await get<ActionResponse>("/session", { id: "s-chat" });
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ ok: false, error: "The bridge could not finish that: the disk is full" });
  });
});
