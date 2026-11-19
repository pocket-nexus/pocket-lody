// The CLI driver over fake-lody.ts, a stand-in that prints what the real
// `lody` prints. Nothing here reaches Lody. The one test that does (read
// only) runs with POCKET_LODY_LIVE=1.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Item } from "../protocol.ts";
import type { BackendChange, LodyBackend } from "./backend.ts";
import { createCliBackend, type CliConfig } from "./cli.ts";
import { locateCli } from "./provider.ts";

// every step starts a process
setDefaultTimeout(30_000);

const FAKE = resolve(import.meta.dir, "fake-lody.ts");
const ME = "user-me";
// two hours ago, on the minute: a session quiet for 12 hours is idle whatever the CLI says (cli-map.ts STALE_STATUS_MS)
const T0 = Math.floor(Date.now() / 60_000) * 60_000 - 2 * 3_600_000;
const FAST = { tickMs: 40, listDebounceMs: 20, listMinGapMs: 0, openRefreshMs: 120, observeBackoffMs: 40, bootWaitMs: 8000, exportEveryMs: 0, listEveryMs: 60_000, listEveryDownMs: 60_000, machinesEveryMs: 60_000 };

let dir = "";
let backend: LodyBackend | undefined;
const changes: BackendChange[] = [];

function meta(id: string, more: Record<string, unknown> = {}) {
  return { id, machineId: "m-1", createdAt: new Date(T0 - 3_600_000).toISOString(), lastMessageAt: T0, lastReadAt: T0, title: `Session ${id}`, userId: ME, status: { type: "idle" }, cliType: "builtin", agentType: "claude", agentConfigId: "cfg-1", historyBackend: "loro", ...more };
}

function entries(id: string, turns: number) {
  const out: Record<string, unknown>[] = [];
  for (let turn = 0; turn < turns; turn++) {
    out.push({ index: turn * 2, id: `u-${id}-${turn}`, role: "user", author: { v: 1, kind: "human", userId: ME }, timestamp: new Date(T0 + turn * 60_000).toISOString(), text: `question ${turn}` });
    out.push({ index: turn * 2 + 1, id: `a-${id}-${turn}`, role: "assistant", timestamp: new Date(T0 + turn * 60_000 + 30_000).toISOString(), text: `answer ${turn}` });
  }
  return out;
}

function world(more: Record<string, unknown> = {}) {
  return {
    workspaces: [
      { id: "ws-a", name: "Quiet Team", slug: "quiet" },
      { id: "ws-b", name: "Busy Team", slug: "busy" },
    ],
    sessions: {
      "ws-a": [meta("old", { lastMessageAt: T0 - 86_400_000 })],
      "ws-b": [meta("one", { lastMessageAt: T0 + 5000, lastReadAt: T0, repoFullName: "example-org/app", project: { kind: "github", repoFullName: "example-org/app", branch: "main" }, branchName: "feat/x" }), meta("two", { machineId: "m-2", userId: "someone-else" }), meta("long"), meta("gone", { isArchived: true })],
    },
    histories: { one: entries("one", 2), two: entries("two", 1), long: entries("long", 75), old: entries("old", 1) },
    machines: {
      "ws-b": [
        { id: "m-1", name: "fake-mac", online: true, onlineStatus: "online", ownerUserId: ME, agentConfigs: [{ id: "cfg-1", machineId: "m-1", name: "Claude", cliType: "builtin", agentType: "claude" }] },
        { id: "m-2", name: "build-box", online: false, onlineStatus: "offline", ownerUserId: "someone-else", agentConfigs: [] },
      ],
    },
    roles: [{ id: "role-1", name: "Reviewer", description: "Reads a diff" }],
    projects: [{ id: "lp-1", name: "notebook", kind: "local", machineId: "m-1", rootPath: "/work/notebook" }],
    ...more,
  };
}

function start(state: Record<string, unknown> = world(), options: { signedIn?: boolean; config?: Partial<CliConfig> } = {}) {
  dir = mkdtempSync(join(tmpdir(), "pocket-lody-test-"));
  writeFileSync(join(dir, "fake.json"), JSON.stringify(state));
  if (options.signedIn !== false) writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, token: "fake-token-not-a-secret", user: { id: ME, email: "me@example.test", name: "Sample Owner" }, machine: { machineName: "fake-mac", machineId: "m-1" } }));
  changes.length = 0;
  backend = createCliBackend({ node: process.execPath, cli: [FAKE], dataDir: dir, cacheDir: join(dir, "cache"), timing: FAST, ...options.config });
  backend.subscribe((change) => changes.push(change));
  return backend;
}

afterEach(() => {
  backend?.close();
  backend = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const calls = () => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { command: string; argv: string[]; stdin: string; inherited: string[]; path0: string }) : []);
const called = (command: string) => calls().filter((call) => call.command === command);
const fake = () => JSON.parse(readFileSync(join(dir, "fake.json"), "utf8")) as { sessions: Record<string, Record<string, unknown>[]>; histories: Record<string, Record<string, unknown>[]> };
const observed = (line: Record<string, unknown>) => writeFileSync(join(dir, "observe.jsonl"), `${JSON.stringify({ version: 1, workspaceId: "ws-b", ...line })}\n`, { flag: "a" });

async function until<T>(read: () => T | Promise<T>, what: string, ms = 8000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const row = async (id: string) => (await backend!.snapshot()).sessions.find((entry) => entry.id === id);
const kinds = (items: Item[]) => items.map((item) => item.k);

describe("the CLI driver", () => {
  test("starts on the workspace someone worked in last, with its sessions and machines", async () => {
    process.env.LODY_SESSION_ID = "must-not-reach-the-cli";
    process.env.LODY_WORKSPACE_SESSION_ID = "must-not-reach-the-cli";
    try {
      start();
      const snapshot = await backend!.snapshot();
      expect(snapshot.link).toEqual({ phase: "ready", driver: "cli", via: "fake-mac", user: { name: "Sample Owner", email: "me@example.test" }, ownAccount: true });
      expect(snapshot.workspaces).toEqual([{ id: "ws-a", name: "Quiet Team" }, { id: "ws-b", name: "Busy Team" }]);
      expect(snapshot.workspaceId).toBe("ws-b");
      expect(snapshot.sessions.map((entry) => entry.id).sort()).toEqual(["gone", "long", "one", "two"]);
      expect(await row("one")).toMatchObject({ title: "Session one", state: "idle", unread: true, mine: true, machineId: "m-1", agent: "Claude", project: "example-org/app", branch: "feat/x" });
      expect((await row("two"))!.mine).toBeUndefined();
      expect((await row("gone"))!.archived).toBe(true);
      // the machine list's JSON sits between two log lines
      await until(async () => (await backend!.snapshot()).machines.length === 2, "the machines");
      expect((await backend!.snapshot()).machines).toEqual([{ id: "m-1", name: "fake-mac", online: true, mine: true }, { id: "m-2", name: "build-box", online: false }]);
      await until(() => called("session observe").length === 1, "the observation");
      expect(called("session observe")[0]!.argv).toEqual(["session", "observe", "--workspace", "ws-b", "--all", "--jsonl", "--follow"]);
      // the session this process runs in is not the bridge's
      expect(calls().flatMap((call) => call.inherited)).toEqual([]);
      // a row's preview comes with the histories read ahead
      await until(async () => (await row("one"))?.preview === "answer 1", "the preview");
    } finally {
      delete process.env.LODY_SESSION_ID;
      delete process.env.LODY_WORKSPACE_SESSION_ID;
    }
  });

  test("a transcript is the history's messages and last texts, and older ones on demand", async () => {
    start();
    const one = (await backend!.transcript("one"))!;
    expect(kinds(one.items)).toEqual(["user", "text", "user", "text"]);
    expect(one.items[0]).toEqual({ k: "user", id: "u-one-0", turn: "u-one-0", at: T0, text: "question 0", author: "Sample Owner", mine: true });
    expect(one.items[3]).toMatchObject({ k: "text", turn: "u-one-1", text: "answer 1", final: true });
    expect(one).toMatchObject({ state: "idle", complete: true, can: { send: true, cancel: false, answer: false } });
    expect(await backend!.transcript("nothing")).toBeNull();
    // the machine of "two" is offline
    await until(async () => (await backend!.snapshot()).machines.length === 2, "the machines");
    expect((await backend!.transcript("two"))!.can.send).toBe(false);

    const long = (await backend!.transcript("long"))!;
    expect(long.items).toHaveLength(60);
    expect(long.complete).toBe(false);
    expect(long.items[0]!.id).toBe("u-long-45");
    expect(await backend!.older("long")).toBe(true);
    const all = (await backend!.transcript("long"))!;
    expect(all.items).toHaveLength(150);
    expect(all.complete).toBe(true);
    expect(await backend!.older("long")).toBe(false);
    expect(called("session history").every((call) => call.argv.includes("--workspace") && call.argv.includes("--json"))).toBe(true);
  });

  test("no more than two commands run at once besides the observation", async () => {
    const state = world({ delay: { "session history": 150, "session list": 80 } });
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      (state.sessions["ws-b"] as Record<string, unknown>[]).push(meta(id));
      (state.histories as Record<string, unknown>)[id] = entries(id, 1);
    }
    start(state);
    await backend!.snapshot();
    await Promise.all(["a", "b", "c", "d", "e", "f", "one", "two"].map((id) => backend!.transcript(id)));
    const counts = readFileSync(join(dir, "concurrency.log"), "utf8").split("\n").filter(Boolean).map(Number);
    expect(counts.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...counts)).toBe(2);
  });

  test("send: shown at once, delivered by `session chat`, then replaced by the history's own entries", async () => {
    start();
    const before = (await backend!.transcript("one"))!.items.length;
    changes.length = 0;
    const text = "check @Session two with @Reviewer";
    await backend!.mentions({ text: "" });
    const answer = await backend!.send({ session: "one", text, mentions: [{ start: 6, end: 18, kind: "session", id: "two" }, { start: 24, end: 33, kind: "role", id: "role-1" }] });
    expect(answer).toEqual({ ok: true });
    const pending = (await backend!.transcript("one"))!.items;
    expect(pending).toHaveLength(before + 1);
    expect(pending.at(-1)).toMatchObject({ k: "user", text, mine: true, delivery: "sending" });
    expect(changes).toContainEqual({ kind: "session", id: "one" });

    const done = await until(async () => {
      const items = (await backend!.transcript("one"))!.items;
      return items.length === before + 3 && !items.some((item) => item.id.startsWith("local:")) ? items : undefined;
    }, "the history to hold the message");
    expect(done.slice(-3).map((item) => item.k)).toEqual(["user", "text", "turn-end"]);
    expect(done.at(-3)).toMatchObject({ id: "u-one-4", mine: true });
    expect(done.at(-1)).toMatchObject({ outcome: "completed", durationMs: 1200 });
    const chat = called("session chat")[0]!;
    expect(chat.argv).toEqual(["session", "chat", "one", "--workspace", "ws-b", "--prompt-file", "-", "--json"]);
    expect(chat.stdin).toBe("check [@Session two](lody://session/two?workspace=ws-b) with [Agent Role: Reviewer (agentRoleId: role-1)]");
    // the bridge's own message is read
    expect((await row("one"))!.unread).toBeUndefined();
  });

  test("a message Lody does not take stays, marked failed, with the reason", async () => {
    start(world({ fail: { "session chat": "Machine fake-mac did not accept the message." } }));
    await backend!.transcript("one");
    expect(await backend!.send({ session: "one", text: "hello" })).toEqual({ ok: true });
    const items = await until(async () => {
      const now = (await backend!.transcript("one"))!.items;
      return now.some((item) => item.k === "user" && item.delivery === "failed") ? now : undefined;
    }, "the failure");
    expect(items.at(-2)).toMatchObject({ k: "user", text: "hello", delivery: "failed" });
    expect(items.at(-1)).toMatchObject({ k: "notice", tone: "error", text: "Lody did not take the message: Machine fake-mac did not accept the message." });
  });

  test("what the CLI cannot do is refused with where to do it", async () => {
    start();
    await backend!.snapshot();
    expect(await backend!.answer({ session: "one", requestId: "r", option: "allow" })).toEqual({ ok: false, error: "This bridge cannot answer a permission or a question. Answer it in Lody on a phone or computer." });
    expect(await backend!.send({ session: "one", text: "faster", steer: true })).toEqual({ ok: false, error: "This bridge cannot steer a running turn. Send the message without steering to queue it, or steer in Lody on a phone or computer." });
    await until(async () => (await backend!.snapshot()).machines.length === 2, "the machines");
    expect(await backend!.send({ session: "two", text: "hi" })).toEqual({ ok: false, error: "build-box is offline, so the message cannot reach it. Wake that computer, or start a session on another." });
    expect(await backend!.send({ session: "gone", text: "hi" })).toEqual({ ok: false, error: "This session is archived; restore it before sending to it." });
    expect(await backend!.send({ session: "nothing", text: "hi" })).toEqual({ ok: false, error: "That session is not in this workspace any more; go back and pick another." });
    expect(called("session chat")).toHaveLength(0);
  });

  test("create: the machine, the agent, the project and the branch become the command's options", async () => {
    start();
    await backend!.snapshot();
    const made = await backend!.create({ machine: "m-1", agent: "cfg-1", project: "gh:example-org/app", branch: "feat/new", text: "Add a dark mode\nfollowing the system" });
    expect(made).toEqual({ ok: true, session: "created-5" });
    const create = called("session create")[0]!;
    expect(create.argv).toEqual(["session", "create", "--workspace", "ws-b", "--machine", "m-1", "--agent", "cfg-1", "--repo", "example-org/app", "--branch", "feat/new", "--prompt-file", "-", "--json"]);
    expect(create.stdin).toBe("Add a dark mode\nfollowing the system");
    expect(await until(() => row("created-5"), "the new session's row")).toMatchObject({ title: "Add a dark mode", state: "starting", project: "example-org/app" });

    await backend!.create({ machine: "m-1", agent: "cfg-1", project: "local:lp-1", worktree: true, text: "local work" });
    expect(called("session create")[1]!.argv.slice(8, 11)).toEqual(["--local-project", "lp-1", "--worktree"]);
    await backend!.create({ machine: "m-1", agent: "cfg-1", project: "chat", branch: "ignored", text: "just chat" });
    expect(called("session create")[2]!.argv).toEqual(["session", "create", "--workspace", "ws-b", "--machine", "m-1", "--agent", "cfg-1", "--prompt-file", "-", "--json"]);
    // a title, when one is given, on one line
    await backend!.create({ machine: "m-1", agent: "cfg-1", title: "  Release\nnotes ", text: "write them" });
    expect(called("session create")[3]!.argv.slice(8)).toEqual(["--title", "Release notes", "--prompt-file", "-", "--json"]);
    expect((await backend!.create({ machine: "m-1", agent: "cfg-1", title: "--json", text: "x" })).ok).toBe(false);
    // nothing chosen on the handheld can read as an option of the command
    expect((await backend!.create({ machine: "--help", agent: "cfg-1", text: "x" })).ok).toBe(false);
    expect((await backend!.create({ machine: "m-1", agent: "cfg-1", project: "gh:example-org/app", branch: "--force", text: "x" })).ok).toBe(false);
    await until(async () => (await backend!.snapshot()).machines.length === 2, "the machines");
    expect(await backend!.create({ machine: "m-2", agent: "cfg-1", text: "x" })).toEqual({ ok: false, error: "build-box is offline; pick another computer or wake it." });
    expect(called("session create")).toHaveLength(4);
  });

  test("a create Lody refuses is its sentence", async () => {
    start(world({ fail: { "session create": "Agent config cfg-9 was not found on machine m-1." } }));
    await backend!.snapshot();
    expect(await backend!.create({ machine: "m-1", agent: "cfg-9", text: "x" })).toEqual({ ok: false, error: "Lody did not start the session: Agent config cfg-9 was not found on machine m-1." });
  });

  test("a session just started opens at once, before the list or its history has it", async () => {
    start(world({ delay: { "session list": 400, "session history": 400 } }));
    await until(async () => (await backend!.snapshot()).sessions.length > 0, "the first list");
    const lists = called("session list").length;
    const made = await backend!.create({ machine: "m-1", agent: "cfg-1", project: "chat", title: "Fresh", text: "hello there" });
    expect(made.ok).toBe(true);
    // no list was read since, and the row and the first message are there
    expect(called("session list").length).toBe(lists);
    expect(await row(made.session!)).toMatchObject({ title: "Fresh", state: "starting", mine: true });
    const opened = (await backend!.transcript(made.session!))!;
    expect(opened.items).toMatchObject([{ k: "user", text: "hello there", mine: true }]);
    // and it stays through a list that was read before Lody listed it
    await until(() => called("session list").length > lists, "the next list");
    expect(await row(made.session!)).toBeTruthy();
  });

  test("a turn's end is shown with its answer, not before", async () => {
    start();
    await backend!.transcript("one");
    await until(() => called("session observe").length === 1, "the observation");
    await new Promise((resolve) => setTimeout(resolve, 300));
    observed({ type: "session.changed", sessionId: "one", session: { sessionId: "one", machineId: "m-1", archived: false, state: "running", source: "persisted", freshness: "synced", latestTurn: { userTurnId: "u-one-9", state: "running" }, activeTurns: [{ userTurnId: "u-one-9", state: "running" }] } });
    await until(async () => (await backend!.transcript("one"))!.state === "running", "the session to run");
    // the answer lands in Lody, and reading it takes a while
    const state = fake() as ReturnType<typeof fake> & { delay?: Record<string, number> };
    state.histories.one!.push({ index: 4, id: "u-one-9", role: "user", author: { v: 1, kind: "human", userId: ME }, timestamp: new Date(T0 + 600_000).toISOString(), text: "and then?" }, { index: 5, id: "a-one-9", role: "assistant", timestamp: new Date(T0 + 601_000).toISOString(), text: "All done" });
    state.delay = { "session history": 500 };
    writeFileSync(join(dir, "fake.json"), JSON.stringify(state));
    await until(async () => !(await backend!.transcript("one"))!.items.some((item) => item.k === "text" && item.text === "All done") && called("session history").length > 0, "a history without the answer");
    observed({ type: "session.changed", sessionId: "one", session: { sessionId: "one", machineId: "m-1", archived: false, state: "idle", source: "persisted", freshness: "synced", latestTurn: { userTurnId: "u-one-9", assistantTurnId: "a-one-9", state: "completed", durationMs: 4000 }, activeTurns: [] } });
    await until(async () => (await row("one"))?.state === "idle", "the row to rest");
    // every transcript from here either still works without the answer, or rests with it
    for (;;) {
      const now = (await backend!.transcript("one"))!;
      const answered = now.items.some((item) => item.k === "text" && item.text === "All done");
      if (now.state === "idle") {
        expect(answered).toBe(true);
        expect(now.items.at(-1)).toMatchObject({ k: "turn-end", outcome: "completed" });
        break;
      }
      expect(now).toMatchObject({ state: "running", can: { cancel: false } });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  });

  test("archiving shows at once, and is undone when Lody refuses", async () => {
    start(world({ delay: { "session archive": 500 } }));
    await backend!.snapshot();
    await until(() => row("one"), "the list");
    const archiving = backend!.archive("one", true);
    await until(async () => (await row("one"))?.archived === true, "the row to move at once", 300);
    expect(called("session archive")).toHaveLength(1);
    expect(await archiving).toEqual({ ok: true });
    expect((await row("one"))!.archived).toBe(true);

    const refusing = fake() as ReturnType<typeof fake> & { fail?: Record<string, string> };
    refusing.fail = { "session rename": "You cannot rename this session." };
    writeFileSync(join(dir, "fake.json"), JSON.stringify(refusing));
    const renamed = await backend!.rename("two", "Other name");
    expect(renamed).toEqual({ ok: false, error: "Lody did not rename the session: You cannot rename this session." });
    expect((await row("two"))!.title).toBe("Session two");
  });

  test("cancel, archive, restore, rename", async () => {
    start();
    await backend!.snapshot();
    expect(await backend!.cancel("one")).toEqual({ ok: true });
    expect(called("session cancel")[0]!.argv).toEqual(["session", "cancel", "one", "--workspace", "ws-b", "--json"]);
    expect(await backend!.archive("one", true)).toEqual({ ok: true });
    expect((await row("one"))!.archived).toBe(true);
    expect(fake().sessions["ws-b"]![0]!.isArchived).toBe(true);
    expect(await backend!.archive("one", false)).toEqual({ ok: true });
    expect(called("session restore")).toHaveLength(1);
    expect((await row("one"))!.archived).toBeUndefined();
    expect(await backend!.rename("one", "--title is fine as a title")).toEqual({ ok: true });
    expect((await row("one"))!.title).toBe("--title is fine as a title");
    expect(fake().sessions["ws-b"]![0]!.title).toBe("--title is fine as a title");
    expect(await backend!.rename("nothing", "x")).toEqual({ ok: false, error: "That session is not in this workspace any more; go back and pick another." });
  });

  test("a read mark is the bridge's own, and is kept", async () => {
    start();
    expect((await row("one"))!.unread).toBe(true);
    changes.length = 0;
    expect(await backend!.read("one")).toEqual({ ok: true });
    expect((await row("one"))!.unread).toBeUndefined();
    expect(changes).toContainEqual({ kind: "snapshot" });
    backend!.close();
    backend = createCliBackend({ node: process.execPath, cli: [FAKE], dataDir: dir, cacheDir: join(dir, "cache"), timing: FAST });
    expect((await row("one"))!.unread).toBeUndefined();
    // the workspace it picked, too: the first start listed both workspaces (and kept the
    // list of the one it chose), the second lists only that one
    expect((await backend.snapshot()).workspaceId).toBe("ws-b");
    expect(called("session list").map((call) => call.argv[3]).sort()).toEqual(["ws-a", "ws-b", "ws-b"]);
  });

  test("the observation moves a row at once and refreshes an open session's history", async () => {
    start();
    await backend!.transcript("one");
    await until(() => called("session observe").length === 1 && (changes.length > 0 || true), "the observation");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lists = called("session list").length;
    observed({ type: "session.changed", sessionId: "one", session: { sessionId: "one", machineId: "m-1", archived: false, state: "running", source: "persisted", freshness: "synced", latestTurn: { userTurnId: "u-one-9", assistantTurnId: "a-one-9", state: "running" }, activeTurns: [{ userTurnId: "u-one-9", assistantTurnId: "a-one-9", state: "running" }] } });
    await until(async () => (await row("one"))?.state === "running", "the row to run");
    const running = (await backend!.transcript("one"))!;
    expect(running).toMatchObject({ state: "running", activeTurn: "u-one-9", can: { cancel: true } });
    // the history held ends with the answer to an earlier turn: that one is not being written
    expect(running.items.at(-1)).toMatchObject({ k: "text", final: true });
    await until(() => called("session list").length > lists, "the list to be read again");

    // while it works and is open, its history is read again and again
    const state = fake();
    state.histories.one!.push({ index: 4, id: "u-one-9", role: "user", author: { v: 1, kind: "human", userId: ME }, timestamp: new Date(T0 + 600_000).toISOString(), text: "and then?" }, { index: 5, id: "a-one-9", role: "assistant", timestamp: new Date(T0 + 601_000).toISOString(), text: "Working on it" });
    writeFileSync(join(dir, "fake.json"), JSON.stringify(state));
    await until(async () => ((await backend!.transcript("one"))!.items.at(-1) as { text?: string }).text === "Working on it", "the growing answer");
    expect((await backend!.transcript("one"))!.items.at(-1)).toMatchObject({ k: "text", streaming: true });

    observed({ type: "turn.finished", sessionId: "one", userTurnId: "u-one-9", assistantTurnId: "a-one-9", outcome: "completed", durationMs: 9000 });
    observed({ type: "session.changed", sessionId: "one", session: { sessionId: "one", machineId: "m-1", archived: false, state: "idle", source: "persisted", freshness: "synced", latestTurn: { userTurnId: "u-one-9", assistantTurnId: "a-one-9", state: "completed", durationMs: 9000 }, activeTurns: [] } });
    const done = await until(async () => {
      const now = (await backend!.transcript("one"))!;
      return now.state === "idle" ? now : undefined;
    }, "the turn to end");
    expect(done.items.slice(-2)).toMatchObject([{ k: "text", final: true }, { k: "turn-end", id: "a-one-9:end", outcome: "completed", durationMs: 9000 }]);
    expect(done.can.cancel).toBe(false);

    const without = fake();
    without.sessions["ws-b"] = without.sessions["ws-b"]!.filter((entry) => entry.id !== "two");
    writeFileSync(join(dir, "fake.json"), JSON.stringify(without));
    observed({ type: "session.removed", sessionId: "two" });
    await until(async () => !(await row("two")), "the removed session to go");
  });

  test("an observation that ends is started again", async () => {
    start();
    await until(() => called("session observe").length === 1, "the observation");
    await new Promise((resolve) => setTimeout(resolve, 200));
    observed({ type: "fake.exit" });
    await until(() => called("session observe").length >= 2, "the observation to start again");
  });

  test("options and roles", async () => {
    start();
    await until(async () => (await backend!.snapshot()).machines.length === 2, "the machines");
    const first = await backend!.options();
    expect(first.machines).toHaveLength(2);
    expect(first.agents).toEqual([{ id: "cfg-1", name: "Claude", machineId: "m-1" }]);
    expect(first.projects.at(-1)).toEqual({ id: "chat", name: "No project", kind: "chat" });
    expect(first.projects).toContainEqual({ id: "gh:example-org/app", name: "example-org/app", kind: "github" });
    // the catalog arrives behind
    const later = await until(async () => {
      const now = await backend!.options("m-1");
      return now.projects.some((project) => project.id === "local:lp-1") ? now : undefined;
    }, "the catalog");
    expect(later.projects).toContainEqual({ id: "local:lp-1", name: "notebook", kind: "local", machineId: "m-1" });
    expect((await backend!.options("m-2")).projects.some((project) => project.id === "local:lp-1")).toBe(false);
    expect(await backend!.mentions({ text: "rev" })).toEqual([{ kind: "role", id: "role-1", label: "Reviewer", detail: "Reads a diff" }]);
  });

  test("switching workspace", async () => {
    start();
    await backend!.snapshot();
    expect(await backend!.workspace("ws-nobody")).toEqual({ ok: false, error: "That workspace is not one this account belongs to." });
    expect(await backend!.workspace("ws-a")).toEqual({ ok: true });
    await until(async () => (await backend!.snapshot()).sessions.some((entry) => entry.id === "old"), "the other workspace's sessions");
    const snapshot = await backend!.snapshot();
    expect(snapshot.workspaceId).toBe("ws-a");
    expect(snapshot.sessions.map((entry) => entry.id)).toEqual(["old"]);
    expect(called("session observe").at(-1)!.argv).toContain("ws-a");
  });

  test("signing in shows the device page and opens no browser", async () => {
    start(world(), { signedIn: false });
    const out = await backend!.snapshot();
    expect(out.link).toMatchObject({ phase: "signed-out", driver: "cli" });
    expect(out.link.detail).toContain("not signed in");
    expect(out.sessions).toEqual([]);
    expect(await backend!.send({ session: "one", text: "hi" })).toEqual({ ok: false, error: "Sign in to Lody on the bridge first." });
    expect(called("workspace list")).toHaveLength(0);

    expect(await backend!.signin()).toEqual({ ok: true });
    const during = await until(async () => {
      const { link } = await backend!.snapshot();
      return link.url ? link : undefined;
    }, "the device page");
    expect(during).toMatchObject({ phase: "signing-in", url: "https://lody.example/device?user_code=FAKE-1234", code: "FAKE-1234", ownAccount: true });
    // the page as a QR code: a square of modules, a finder pattern in its first row
    expect(during.qr!.length).toBeGreaterThanOrEqual(29);
    expect(during.qr!.every((row) => row.length === during.qr!.length)).toBe(true);
    expect(during.qr![0]).toMatch(/^11111110[01]+01111111$/);
    // the CLI says when the code expires, a line after the page
    const expiring = await until(async () => (await backend!.snapshot()).link.expiresAt, "the code's expiry");
    expect(expiring).toBe(Date.parse("2030-01-01T00:30:00.000Z"));
    // `open` and `xdg-open` resolve to commands that do nothing
    const login = called("login")[0]!;
    expect(login.path0).toBe(join(dir, "cache", "shims"));
    expect(readFileSync(join(login.path0, "open"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(await backend!.signin()).toEqual({ ok: true });
    expect(called("login")).toHaveLength(1);

    writeFileSync(join(dir, "approve"), "");
    const ready = await until(async () => {
      const snapshot = await backend!.snapshot();
      return snapshot.link.phase === "ready" && snapshot.sessions.length ? snapshot : undefined;
    }, "the sign-in to finish");
    expect(ready.link).toEqual({ phase: "ready", driver: "cli", via: "fake-mac", user: { name: "Sample Owner", email: "me@example.test" }, ownAccount: true });
    // nothing the driver says carries the token
    expect(JSON.stringify(ready)).not.toContain("fake-token");
  });

  test("a device signs in under the name its config gives it", async () => {
    start(world(), { signedIn: false, config: { machineName: "AYN Thor" } });
    expect((await backend!.snapshot()).link).toMatchObject({ phase: "signed-out", via: "AYN Thor", machine: "AYN Thor", ownAccount: true });
    expect(await backend!.signin()).toEqual({ ok: true });
    await until(async () => (await backend!.snapshot()).link.url, "the device page");
    expect(called("login")[0]!.argv).toEqual(["login", "--debug", "--machine-name", "AYN Thor"]);
    writeFileSync(join(dir, "approve"), "");
    const ready = await until(async () => {
      const snapshot = await backend!.snapshot();
      return snapshot.link.phase === "ready" ? snapshot : undefined;
    }, "the sign-in to finish");
    expect(ready.link).toEqual({ phase: "ready", driver: "cli", via: "AYN Thor", user: { name: "Sample Owner", email: "me@example.test" }, ownAccount: true });
  });

  test("a code that expires says so, and a second sign-in starts a new one", async () => {
    start(world(), { signedIn: false });
    expect(await backend!.signin()).toEqual({ ok: true });
    await until(async () => (await backend!.snapshot()).link.url, "the device page");
    writeFileSync(join(dir, "expire"), "");
    const after = await until(async () => {
      const { link } = await backend!.snapshot();
      return link.phase === "signed-out" ? link : undefined;
    }, "the sign-in to end");
    expect(after.detail).toBe("The sign-in code expired before it was confirmed. Start the sign-in again for a new one.");
    expect(after.url).toBeUndefined();
    rmSync(join(dir, "expire"));
    expect(await backend!.signin()).toEqual({ ok: true });
    await until(async () => (await backend!.snapshot()).link.url, "the device page again");
    expect(called("login")).toHaveLength(2);
  });

  test("a sign-in that is called off leaves the device signed out", async () => {
    start(world(), { signedIn: false });
    expect(await backend!.signin()).toEqual({ ok: true });
    await until(async () => (await backend!.snapshot()).link.url, "the device page");
    expect(await backend!.signout()).toEqual({ ok: true });
    const { link } = await backend!.snapshot();
    expect(link.phase).toBe("signed-out");
    expect(link.url).toBeUndefined();
    expect(link.code).toBeUndefined();
  });

  test("signing out: the bridge's own account can, the computer's shared one is refused", async () => {
    start();
    await backend!.snapshot();
    expect(await backend!.signout()).toEqual({ ok: true });
    expect(called("logout")).toHaveLength(1);
    expect((await backend!.snapshot()).link.phase).toBe("signed-out");
    backend!.close();

    // without a data directory of its own, the sign-in is the computer's
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, token: "fake-token-not-a-secret", user: { id: ME, name: "Sample Owner" }, machine: { machineName: "fake-mac", machineId: "m-1" } }));
    process.env.LODY_DATA_DIR = dir;
    try {
      backend = createCliBackend({ node: process.execPath, cli: [FAKE], cacheDir: join(dir, "cache"), timing: FAST });
      expect((await backend.snapshot()).link.phase).toBe("ready");
      expect(await backend.signout()).toEqual({ ok: false, error: "This bridge uses the Lody sign-in of fake-mac itself, which the Lody app there shares. Sign out on that computer with `lody logout`." });
      expect(called("logout")).toHaveLength(1);
    } finally {
      delete process.env.LODY_DATA_DIR;
    }
  });

  test("a CLI that says it is not signed in is a signed-out bridge; a missing Node is an unavailable one", async () => {
    start(world({ fail: { "workspace list": "Not logged in. Run `lody login` first." } }));
    expect((await backend!.snapshot()).link.phase).toBe("signed-out");
    backend!.close();
    backend = createCliBackend({ node: join(dir, "no-such-node"), cli: [FAKE], dataDir: dir, cacheDir: join(dir, "cache"), timing: FAST });
    const { link } = await backend.snapshot();
    expect(link.phase).toBe("unavailable");
    expect(link.detail).toContain("Node is not at");
    expect(await backend.transcript("one")).toBeNull();
    expect((await backend.create({ machine: "m-1", agent: "cfg-1", text: "x" })).ok).toBe(false);
  });

  test("with richTranscripts: \"export\", an opened session gets every item from the export, and the export is removed", async () => {
    const exported = {
      session: { sessionId: "one" },
      turns: [
        { turnId: "u-one-0", role: "user", timestamp: new Date(T0).toISOString(), finished: true, items: [{ type: "text", text: "question 0" }] },
        { turnId: "a-one-0", role: "assistant", timestamp: new Date(T0 + 30_000).toISOString(), finished: true, startedAt: T0, endedAt: T0 + 30_000, modelInfo: { name: "Sample Model 4" }, items: [{ type: "thought", text: "thinking" }, { type: "tool_call", toolCallId: "t", title: "Run tests", kind: "execute", status: "completed", content: [{ type: "terminal_command", command: "bun test" }, { type: "terminal_output", output: "3 pass" }] }, { type: "text", text: "answer 0", messagePhase: "final_answer" }] },
      ],
    };
    start(world({ exports: { one: exported } }), { config: { richTranscripts: "export" } });
    const rich = await until(async () => {
      const now = (await backend!.transcript("one"))!;
      return now.items.some((item) => item.k === "tool") ? now : undefined;
    }, "the export");
    // the first turn in full, the second as the history has it
    expect(kinds(rich.items)).toEqual(["user", "thought", "tool", "text", "turn-end", "user", "text"]);
    expect(rich.items[2]).toMatchObject({ kind: "execute", detail: "bun test", output: "3 pass", status: "done" });
    expect(rich.items.slice(-2).map((item) => item.id)).toEqual(["u-one-1", "a-one-1"]);
    expect(called("export")[0]!.argv.slice(0, 5)).toEqual(["export", "--offline", "--no-images", "--workspace", "ws-b"]);
    await until(() => !existsSync(join(dir, "cache", "export")), "the export to be removed");
  });
});

// Read-only against the account this computer is signed in to:
//   POCKET_LODY_LIVE=1 bun test ./service/cli.test.ts -t live
// It runs `workspace list`, `session list`, `machine list`, `session observe`
// and `session history`, and prints counts and timings, never a title or a message.
describe.skipIf(process.env.POCKET_LODY_LIVE !== "1")("live", () => {
  test(
    "the real CLI: a snapshot and one transcript",
    async () => {
      const located = locateCli();
      if ("missing" in located) throw new Error(located.missing);
      const cache = mkdtempSync(join(tmpdir(), "pocket-lody-live-"));
      mkdirSync(cache, { recursive: true });
      const lines: string[] = [];
      const live = createCliBackend({ ...located, cacheDir: cache, log: (line) => lines.push(line) });
      try {
        const started = Date.now();
        const snapshot = await until(async () => {
          const now = await live.snapshot();
          return now.link.phase !== "ready" || now.sessions.length ? now : undefined;
        }, "the workspace", 120_000);
        console.log(`live: phase ${snapshot.link.phase}, ${snapshot.workspaces.length} workspaces, ${snapshot.sessions.length} sessions, ${snapshot.machines.length} machines, ${JSON.stringify(snapshot).length} bytes, ${Date.now() - started} ms`);
        expect(snapshot.link.phase).toBe("ready");
        const recent = [...snapshot.sessions].filter((entry) => !entry.archived).sort((a, b) => b.updatedAt - a.updatedAt);
        console.log(`live: states ${JSON.stringify(Object.fromEntries([...new Set(snapshot.sessions.map((entry) => entry.state))].map((state) => [state, snapshot.sessions.filter((entry) => entry.state === state).length])))}, ${snapshot.sessions.filter((entry) => entry.unread).length} unread, ${snapshot.sessions.filter((entry) => entry.prs).length} with PRs, ${snapshot.sessions.filter((entry) => entry.parentId).length} child tabs`);
        const machines = await until(async () => ((await live.snapshot()).machines.length ? (await live.snapshot()).machines : undefined), "the machines", 60_000);
        console.log(`live: ${machines.length} machines, ${machines.filter((machine) => machine.online).length} online`);
        // the most recent sessions are read ahead; one of them opens from what is held
        await until(() => lines.filter((line) => line.includes("session history")).length >= Math.min(6, recent.length), "the read-ahead", 150_000);
        let opened = Date.now();
        const held = (await live.transcript(recent[0]!.id))!;
        console.log(`live: a session read ahead opens in ${Date.now() - opened} ms: ${held.items.length} items (${[...new Set(held.items.map((item) => item.k))].join(", ")}), state ${held.state}, complete ${held.complete}`);
        expect(held.items.length).toBeGreaterThan(0);
        // one that was not is one `session history`
        const cold = recent[Math.min(12, recent.length - 1)]!;
        opened = Date.now();
        const transcript = (await live.transcript(cold.id))!;
        console.log(`live: a session not held opens in ${Date.now() - opened} ms: ${transcript.items.length} items, state ${transcript.state}, complete ${transcript.complete}`);
        const options = await live.options();
        console.log(`live: options ${options.machines.length} machines, ${options.agents.length} agents, ${options.projects.length} projects (before the catalog)`);
        for (const line of lines) console.log(`live: ${line}`);
      } finally {
        live.close();
        rmSync(cache, { recursive: true, force: true });
      }
    },
    400_000,
  );
});
