#!/usr/bin/env bun
// pocket-lody/service/fake-lody.ts — a stand-in for the `lody` CLI, for
// cli.test.ts. It prints what the real CLI prints for the commands cli.ts
// runs (shapes as of lody 0.113.1), over a workspace kept in
// $LODY_DATA_DIR/fake.json. Nothing here talks to Lody.
//
// Every invocation is appended to $LODY_DATA_DIR/calls.jsonl: its arguments,
// what it read on stdin, and which of the environment's session variables
// reached it. `session observe --follow` prints the catalog and then every
// line appended to $LODY_DATA_DIR/observe.jsonl. `login` prints a device
// page and waits for $LODY_DATA_DIR/approve to appear.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, any>;

const dir = process.env.LODY_DATA_DIR ?? "";
const argv = process.argv.slice(2);
const statePath = join(dir, "fake.json");
const credentials = join(dir, "credentials.json");
const observeLog = join(dir, "observe.jsonl");

const has = (name: string) => argv.includes(name);
const flag = (name: string) => {
  const joined = argv.find((arg) => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const load = (): Json => JSON.parse(readFileSync(statePath, "utf8"));
const store = (state: Json) => writeFileSync(statePath, JSON.stringify(state));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(error: string): never {
  if (has("--json") || has("--jsonl")) print(has("--jsonl") ? { type: "error", error } : { ok: false, error });
  else console.error(error);
  process.exit(1);
}

const command = `${argv[0] ?? ""}${argv[1] && /^[a-z][a-z-]*$/.test(argv[1]) ? ` ${argv[1]}` : ""}`;
const stdin = command === "session chat" || command === "session create" ? await Bun.stdin.text() : "";
appendFileSync(
  join(dir, "calls.jsonl"),
  `${JSON.stringify({ command, argv, stdin, inherited: ["LODY_SESSION_ID", "LODY_AGENT_SESSION_ID", "LODY_WORKSPACE_SESSION_ID", "LODY_WORKSPACE_ID"].filter((name) => process.env[name] !== undefined), path0: (process.env.PATH ?? "").split(":")[0] })}\n`,
);

if (has("--version")) {
  console.log("0.113.1");
  process.exit(0);
}

if (command === "login") {
  // `--machine-name <name>` names the machine; `--debug` says when the code expires
  const named = argv.indexOf("--machine-name");
  const machineName = named >= 0 && argv[named + 1] ? argv[named + 1]! : "fake-mac";
  if (has("--debug")) console.log("[auth] server https://backend.lody.example site https://lody.example");
  console.log(`  Machine Name: ${machineName}`);
  console.log("==================================================");
  console.log("Device Authorization");
  console.log("\nPlease visit: https://lody.example/device?user_code=FAKE-1234");
  console.log("Attempting to open the URL in your default browser...");
  if (has("--debug")) console.log("[device-auth] polling config: interval=5s (5000ms sleep) expires_in=1800s deadline=2030-01-01T00:30:00.000Z");
  for (let waited = 0; waited < 20_000 && !existsSync(join(dir, "approve")) && !existsSync(join(dir, "expire")); waited += 25) await sleep(25);
  if (existsSync(join(dir, "expire"))) {
    console.log("✖ Authorization code expired");
    process.exit(1);
  }
  if (!existsSync(join(dir, "approve"))) process.exit(1);
  writeFileSync(credentials, JSON.stringify({ version: 1, token: "fake-token-not-a-secret", user: { id: "user-me", email: "me@example.test", name: "Sample Owner" }, machine: { machineName, machineId: "m-1" }, createdAt: new Date().toISOString() }));
  console.log("✓ Successfully logged in!");
  process.exit(0);
}

if (command === "logout") {
  rmSync(credentials, { force: true });
  console.log("✓ Successfully logged out!");
  process.exit(0);
}

if (!existsSync(credentials)) fail("Not logged in. Run `lody login` first.");

const state = load();
// how many commands run at once, besides the observation
if (command !== "session observe") {
  const mark = join(dir, `run-${process.pid}`);
  writeFileSync(mark, "");
  process.on("exit", () => rmSync(mark, { force: true }));
  appendFileSync(join(dir, "concurrency.log"), `${readdirSync(dir).filter((name) => name.startsWith("run-")).length}\n`);
  const delay = Number(state.delay?.[command] ?? 0);
  if (delay > 0) await sleep(delay);
}
const refusal = state.fail?.[command];
if (refusal) fail(refusal);

const workspaceOf = () => {
  const selector = flag("--workspace");
  if (!selector) fail(`Multiple workspaces are available; pass --workspace. Candidates: ${state.workspaces.map((w: Json) => w.name).join(", ")}`);
  const found = state.workspaces.find((w: Json) => w.id === selector || w.slug === selector || w.name === selector);
  if (!found) fail(`Workspace not found: ${selector}`);
  return found as Json;
};
const positional = () => argv.filter((arg, at) => at >= 2 && !arg.startsWith("-") && !(argv[at - 1] ?? "").startsWith("--"))[0];
const sessionsOf = (workspaceId: string): Json[] => (state.sessions[workspaceId] ??= []);
const findSession = (workspaceId: string, id: string | undefined) => sessionsOf(workspaceId).find((session) => session.id === id) ?? fail(`Session not found: ${id}`);
const observed = (line: Json) => appendFileSync(observeLog, `${JSON.stringify({ version: 1, streamId: "fake", sequence: Date.now(), observedAt: Date.now(), ...line })}\n`);

switch (command) {
  case "workspace list":
    print({ ok: true, workspaces: state.workspaces });
    break;

  case "session list": {
    const workspace = workspaceOf();
    let sessions = sessionsOf(workspace.id).filter((session) => (has("--all") ? true : has("--archived") ? session.isArchived : !session.isArchived));
    sessions = [...sessions].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    const limit = Number(flag("--limit"));
    print({ ok: true, workspaceId: workspace.id, sessions: limit > 0 ? sessions.slice(0, limit) : sessions });
    break;
  }

  case "session history": {
    const workspace = workspaceOf();
    const id = positional();
    findSession(workspace.id, id);
    const entries: Json[] = state.histories[id!] ?? [];
    const limit = Number(flag("--limit") ?? 50);
    const chosen = entries.slice(-limit);
    print({ ok: true, workspaceId: workspace.id, sessionId: id, total: entries.length, returned: chosen.length, entries: chosen });
    break;
  }

  case "machine list": {
    const workspace = workspaceOf();
    // the real command prints a log line on stdout before and after its JSON
    console.log("[fake] Remote Streams transport attached");
    console.log(JSON.stringify({ ok: true, workspaceId: workspace.id, machines: state.machines[workspace.id] ?? [] }, null, 2));
    console.log("[fake] Remote Streams transport detached");
    break;
  }

  case "agent-role list":
    print({ ok: true, workspaceId: workspaceOf().id, items: state.roles ?? [], hasMore: false, roles: state.roles ?? [] });
    break;

  case "project list":
    print({ ok: true, workspaceId: workspaceOf().id, items: state.projects ?? [], hasMore: false, projects: state.projects ?? [] });
    break;

  case "session observe": {
    const workspace = workspaceOf();
    if (!has("--all") || !has("--jsonl") || !has("--follow")) fail("the fake observes only with --all --jsonl --follow");
    let sequence = 0;
    const envelope = (line: Json) => print({ ...line, version: 1, streamId: "fake", sequence: ++sequence, observedAt: Date.now(), workspaceId: workspace.id });
    for (const session of sessionsOf(workspace.id)) {
      envelope({ type: "snapshot", sessionId: session.id, session: { sessionId: session.id, machineId: session.machineId, title: session.title, archived: session.isArchived === true, state: "unknown", source: "metadata", freshness: "synced", activeTurns: [] } });
    }
    envelope({ type: "ready" });
    let read = existsSync(observeLog) ? readFileSync(observeLog, "utf8").length : 0;
    process.on("SIGTERM", () => process.exit(0));
    for (;;) {
      await sleep(20);
      if (!existsSync(observeLog)) continue;
      const text = readFileSync(observeLog, "utf8");
      if (text.length <= read) continue;
      for (const line of text.slice(read).split("\n").filter(Boolean)) {
        if (line.includes('"fake.exit"')) process.exit(1);
        process.stdout.write(`${line}\n`);
      }
      read = text.length;
    }
  }

  case "session chat": {
    const workspace = workspaceOf();
    const id = positional();
    const session = findSession(workspace.id, id);
    if (flag("--prompt-file") !== "-") fail("the fake reads a prompt only from --prompt-file -");
    const entries: Json[] = (state.histories[id!] ??= []);
    const n = entries.length;
    const now = Date.now();
    const userTurnId = `u-${id}-${n}`;
    const assistantTurnId = `a-${id}-${n}`;
    entries.push({ index: n, id: userTurnId, role: "user", author: { v: 1, kind: "human", userId: "user-me" }, timestamp: new Date(now).toISOString(), text: stdin });
    entries.push({ index: n + 1, id: assistantTurnId, role: "assistant", timestamp: new Date(now + 1).toISOString(), text: `Echo: ${stdin}` });
    session.lastMessageAt = now + 1;
    session.latestUserMsgId = userTurnId;
    session.lastHandledUserMsgId = userTurnId;
    store(state);
    observed({ type: "turn.finished", workspaceId: workspace.id, sessionId: id, userTurnId, assistantTurnId, outcome: "completed", durationMs: 1200 });
    observed({ type: "session.changed", workspaceId: workspace.id, sessionId: id, session: { sessionId: id, machineId: session.machineId, title: session.title, archived: false, state: "idle", source: "persisted", freshness: "synced", latestTurn: { userTurnId, assistantTurnId, state: "completed", durationMs: 1200 }, activeTurns: [] } });
    print({ ok: true, sessionId: id, workspaceId: workspace.id, machineId: session.machineId, userTurnId });
    break;
  }

  case "session create": {
    const workspace = workspaceOf();
    const machineId = flag("--machine");
    if (!machineId || !flag("--agent")) fail("Missing --machine or --agent.");
    const id = `created-${sessionsOf(workspace.id).length + 1}`;
    const now = Date.now();
    const repo = flag("--repo");
    sessionsOf(workspace.id).push({ id, machineId, createdAt: new Date(now).toISOString(), lastMessageAt: now, title: flag("--title") ?? stdin.split("\n")[0]!.slice(0, 40), userId: "user-me", status: { type: "initializing" }, cliType: "builtin", agentType: "claude", agentConfigId: flag("--agent"), latestUserMsgId: `u-${id}-0`, ...(repo ? { repoFullName: repo, project: { kind: "github", repoFullName: repo, branch: flag("--branch") ?? "main" } } : {}) });
    state.histories[id] = [{ index: 0, id: `u-${id}-0`, role: "user", author: { v: 1, kind: "human", userId: "user-me" }, timestamp: new Date(now).toISOString(), text: stdin }];
    store(state);
    print({ ok: true, sessionId: id, workspaceId: workspace.id, machineId, agentConfigId: flag("--agent"), userTurnId: `u-${id}-0` });
    break;
  }

  case "session cancel": {
    const workspace = workspaceOf();
    const session = findSession(workspace.id, positional());
    session.status = { type: "idle" };
    store(state);
    print({ ok: true, sessionId: session.id, response: { success: true } });
    break;
  }

  case "session archive":
  case "session restore": {
    const workspace = workspaceOf();
    const session = findSession(workspace.id, positional());
    session.isArchived = command === "session archive";
    store(state);
    print({ ok: true, sessionId: session.id, [command === "session archive" ? "archivedChildSessionIds" : "restoredChildSessionIds"]: [] });
    break;
  }

  case "session rename": {
    const workspace = workspaceOf();
    const session = findSession(workspace.id, positional());
    const title = flag("--title");
    if (!title) fail("Missing title.");
    session.title = title;
    store(state);
    print({ ok: true, sessionId: session.id, title });
    break;
  }

  case "export": {
    const workspace = workspaceOf();
    const out = join(argv[argv.length - 1]!, workspace.slug ?? workspace.id);
    const index: Json[] = [];
    for (const [id, transcript] of Object.entries(state.exports ?? {})) {
      const relativePath = `sessions/${id}`;
      mkdirSync(join(out, relativePath), { recursive: true });
      writeFileSync(join(out, relativePath, "transcript.json"), JSON.stringify(transcript));
      index.push({ sessionId: id, relativePath });
    }
    mkdirSync(join(out, "sessions"), { recursive: true });
    writeFileSync(join(out, "sessions", "index.json"), JSON.stringify(index));
    console.log(`Exported ${index.length} session(s) from ${workspace.name} to ${out}`);
    break;
  }

  default:
    fail(`unknown command '${argv.join(" ")}'`);
}
