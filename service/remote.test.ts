// The remote driver against a serve.ts in this process: a handheld's service
// over a bridge on another computer, with the fixture as that bridge's driver.
import { afterEach, describe, expect, test } from "bun:test";
import type { ActionResponse, Item, SyncResponse, Transcript } from "../protocol.ts";
import type { BackendChange } from "./backend.ts";
import { createFixtureBackend, FIXTURE_TURN_MS, type FixtureBackend } from "./fixture.ts";
import { createRemoteBackend } from "./remote.ts";
import { startServer, type Served } from "./serve.ts";
import { createLodyService, type LodyService } from "./service.ts";

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const KEY = "a-key-for-tests-only";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let far: FixtureBackend;
let served: Served | undefined;
let near: LodyService | undefined;
const lines: string[] = [];

function bridge(key: string | null = KEY) {
  far = createFixtureBackend({ now: NOW, via: "Studio Mac" });
  lines.length = 0;
  served = startServer({ backend: far, port: 0, ...(key ? { key } : {}), log: (line) => lines.push(line) });
  return served;
}

afterEach(async () => {
  near?.close();
  near = undefined;
  await served?.stop();
  served = undefined;
});

async function until<T>(read: () => T | Promise<T>, what: string, ms = 5000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
  const response = await near!.handle({ method: "GET", path, query: new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string])), body: new Uint8Array(0) });
  return JSON.parse(decoder.decode(response.body)) as T;
}

async function post(path: string, body: unknown = {}): Promise<ActionResponse> {
  const response = await near!.handle({ method: "POST", path, query: new URLSearchParams(), body: encoder.encode(JSON.stringify(body)) });
  return JSON.parse(decoder.decode(response.body)) as ActionResponse;
}

describe("a bridge on another computer", () => {
  test("the workspace comes through, linked as remote through the far computer", async () => {
    const { url } = bridge();
    const remote = createRemoteBackend({ url, key: KEY });
    near = createLodyService(remote, { seed: 0 });
    const { snapshot } = await get<SyncResponse>("/sync", { rev: 0 });
    expect(snapshot!.link).toEqual({ phase: "ready", driver: "remote", via: "Studio Mac", user: { name: "林夏", email: "linxia@lantern.example" }, ownAccount: true });
    expect(snapshot!.sessions).toEqual((await far.snapshot()).sessions);
    expect(snapshot!.machines).toEqual((await far.snapshot()).machines);
  });

  test("a far change answers a near long poll", async () => {
    const { url } = bridge();
    near = createLodyService(createRemoteBackend({ url, key: KEY }), { seed: 0 });
    const first = await get<SyncResponse>("/sync", { rev: 0 });
    const started = Date.now();
    const held = get<SyncResponse>("/sync", { rev: first.rev, wait: 10 });
    setTimeout(() => void far.rename("s-chat", "renamed far away"), 60);
    const answered = await held;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(answered.snapshot!.sessions.find((row) => row.id === "s-chat")!.title).toBe("renamed far away");
  });

  test("a transcript crosses as increments and stays the far driver's list through a turn", async () => {
    const { url } = bridge();
    const remote = createRemoteBackend({ url, key: KEY });
    const heard: BackendChange[] = [];
    remote.subscribe((change) => heard.push(change));
    near = createLodyService(remote, { seed: 0 });
    const opened = await get<Transcript>("/session", { id: "s-docs", limit: 200 });
    expect(opened.items).toEqual((await far.transcript("s-docs"))!.items);

    expect(await post("/send", { session: "s-docs", text: "再看一遍标题层级" })).toEqual({ ok: true });
    const held = new Map<string, Item>(opened.items.map((item) => [item.id, item]));
    let rev = opened.rev;
    let list = opened.items;
    for (let elapsed = 0; elapsed <= FIXTURE_TURN_MS + 800; elapsed += 400) {
      far.advance(400);
      const want = (await far.transcript("s-docs"))!.items;
      // the far change reaches the near driver through its held poll
      list = await until(async () => {
        const step = await get<Transcript>("/session", { id: "s-docs", rev });
        rev = step.rev;
        for (const item of step.items) held.set(item.id, item);
        const merged = step.order!.map((id) => held.get(id)!);
        return JSON.stringify(merged) === JSON.stringify(want) ? merged : undefined;
      }, `the items at ${elapsed} ms`);
    }
    expect(list.at(-1)).toMatchObject({ k: "turn-end", outcome: "completed" });
    expect(heard.filter((change) => change.kind === "session" && change.id === "s-docs").length).toBeGreaterThan(3);
    // only what changed crossed: the transcript calls after the first are small
    const transcripts = lines.filter((line) => line.includes("POST /lody/_backend/transcript"));
    const sizes = transcripts.map((line) => Number(/ (\d+)B /.exec(line)![1]));
    expect(sizes.length).toBeGreaterThan(5);
    expect(Math.max(...sizes.slice(1))).toBeLessThan(sizes[0]!);
  });

  test("actions, refusals, options and mentions cross", async () => {
    const { url } = bridge();
    near = createLodyService(createRemoteBackend({ url, key: KEY }), { seed: 0 });
    await get<SyncResponse>("/sync", { rev: 0 });
    expect(await post("/send", { session: "s-air", text: "hi" })).toEqual({ ok: false, error: "林夏的 MacBook Air is offline, so the message cannot reach it. Wake that computer, or start a session on another." });
    const made = await post("/create", { machine: "m-studio", agent: "a-claude-studio", text: "start far away" });
    expect(made.ok).toBe(true);
    expect((await far.transcript(made.session!))!.items[0]).toMatchObject({ k: "user", text: "start far away" });
    expect(await post("/read", { session: "s-kite-table" })).toEqual({ ok: true });
    expect((await far.snapshot()).sessions.find((row) => row.id === "s-kite-table")!.unread).toBe(false);
    expect((await get<{ machines: unknown[] }>("/options")).machines).toHaveLength(3);
    expect((await get<{ id: string }[]>("/mentions", { q: "发布", kind: "role" })).map((row) => row.id)).toEqual(["role-release"]);
    expect((await get<ActionResponse>("/session", { id: "nothing" })).ok).toBe(false);
    await post("/workspace", { id: "ws-home" });
    await until(async () => (await get<SyncResponse>("/sync", { rev: 0 })).snapshot!.workspaceId === "ws-home", "the workspace switch");
  });

  test("a wrong key and a bridge that is not there are an unavailable link with what to do", async () => {
    const { url } = bridge();
    near = createLodyService(createRemoteBackend({ url, key: "not-the-key-at-all" }), { seed: 0 });
    const refused = (await get<SyncResponse>("/sync", { rev: 0 })).snapshot!;
    const host = new URL(url).host;
    expect(refused.link).toEqual({ phase: "unavailable", driver: "remote", via: host, detail: `The bridge at ${host} refused this device's key; put the key it was started with in this device's config.` });
    expect(refused.sessions).toEqual([]);
    expect((await post("/send", { session: "s-chat", text: "hi" })).error).toContain("refused this device's key");
    near.close();

    near = createLodyService(createRemoteBackend({ url: "http://127.0.0.1:9" }), { seed: 0 });
    const gone = (await get<SyncResponse>("/sync", { rev: 0 })).snapshot!;
    expect(gone.link.phase).toBe("unavailable");
    expect(gone.link.detail).toContain("The bridge at 127.0.0.1:9 does not answer");
    expect(gone.link.detail).toContain("Check that it is running");
  });

  test("a bridge that comes back is found again", async () => {
    const first = bridge();
    const port = first.port;
    const remote = createRemoteBackend({ url: first.url, key: KEY, waitSeconds: 1 });
    near = createLodyService(remote, { seed: 0 });
    expect((await get<SyncResponse>("/sync", { rev: 0 })).snapshot!.link.phase).toBe("ready");
    const opened = await get<Transcript>("/session", { id: "s-chat" });
    await served!.stop();
    await until(async () => (await get<SyncResponse>("/sync", { rev: 0 })).snapshot!.link.phase === "unavailable", "the link to drop");
    // another life of the bridge, where the session has moved on
    far = createFixtureBackend({ now: NOW, via: "Studio Mac" });
    await far.send({ session: "s-chat", text: "sent while the handheld was away" });
    served = startServer({ backend: far, port, key: KEY });
    await until(async () => (await get<SyncResponse>("/sync", { rev: 0 })).snapshot!.link.phase === "ready", "the link to return", 10_000);
    const again = await until(async () => {
      const now = await get<Transcript>("/session", { id: "s-chat" });
      return now.items.length === opened.items.length + 1 ? now : undefined;
    }, "the transcript to catch up");
    expect(again.items.at(-1)).toMatchObject({ text: "sent while the handheld was away" });
  }, 20_000);
});

describe("serve.ts", () => {
  test("the applet's routes are under /lody, behind the key", async () => {
    const { url } = bridge();
    expect((await fetch(`${url}/lody/sync?rev=0`)).status).toBe(401);
    expect((await fetch(`${url}/lody/sync?rev=0`, { headers: { authorization: "Bearer wrong-key-entirely" } })).status).toBe(401);
    expect((await fetch(`${url}/lody/_backend/call`, { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await fetch(`${url}/lody/sync?rev=0`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as SyncResponse).snapshot!.sessions.length).toBeGreaterThan(10);
    const sent = await fetch(`${url}/lody/send`, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify({ session: "s-chat", text: "a private message" }) });
    expect(await sent.json()).toEqual({ ok: true });
    expect((await fetch(`${url}/elsewhere`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(404);
    expect((await fetch(`${url}/lody/nothing`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(404);
    // one line a request: no query, no body, no key
    expect(lines).toHaveLength(7);
    expect(lines[3]).toMatch(/^GET \/lody\/sync 200 \d+B \d+ms$/);
    expect(lines[4]).toMatch(/^POST \/lody\/send 200 \d+B \d+ms$/);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain("private message");
    expect(lines.join("\n")).not.toContain("rev=");
  });

  test("a held sync over HTTP is answered by a change, and an abandoned one is let go", async () => {
    const { url } = bridge(null);
    const first = (await (await fetch(`${url}/lody/sync?rev=0`)).json()) as SyncResponse;
    const held = fetch(`${url}/lody/sync?rev=${first.rev}&wait=20`);
    setTimeout(() => void far.rename("s-chat", "over http"), 50);
    const answered = (await (await held).json()) as SyncResponse;
    expect(answered.snapshot!.sessions.find((row) => row.id === "s-chat")!.title).toBe("over http");
    const abort = new AbortController();
    const abandoned = fetch(`${url}/lody/sync?rev=${answered.rev}&wait=20`, { signal: abort.signal }).catch((error: Error) => error.name);
    setTimeout(() => abort.abort(), 40);
    expect(await abandoned).toBe("AbortError");
    await until(() => lines.some((line) => /^GET \/lody\/sync 408 /.test(line)), "the abandoned request to end");
  });

  test("it will not listen beyond this computer without a key", () => {
    expect(() => startServer({ backend: createFixtureBackend({ now: NOW }), host: "0.0.0.0", port: 0 })).toThrow("Refusing to listen on 0.0.0.0 without a key");
    expect(() => startServer({ backend: createFixtureBackend({ now: NOW }), host: "127.0.0.1", port: 0, key: "short" })).toThrow("at least 8 characters");
  });
});
