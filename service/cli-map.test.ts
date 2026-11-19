// The CLI driver's reading of the lody CLI's JSON. The samples have the
// shapes lody 0.113.1 prints; every id, title and message is invented.
import { describe, expect, test } from "bun:test";
import { agentName, capRows, cleanError, isSignedOutError, loginFailure, mapExportTranscript, mapHistory, mapMachines, mapProjects, mapRoles, mapSessionRow, mapWorkspaces, mentionText, nodeRunsLody, parseCliJson, parseLoginOutput, parseObserveLine, projectsOfSessions, sessionState } from "./cli-map.ts";

const ME = "user-0001";
const T0 = Date.UTC(2026, 10, 18, 8, 0, 0);

const META = {
  acpSessionId: "acp-1",
  agentConfigId: "cfg-claude",
  agentType: "claude",
  baseBranch: "main",
  branchName: "feat/retry-jitter",
  cliType: "builtin",
  createdAt: "2026-11-18T07:00:00.000Z",
  diffStats: { allChange: { add: 40, del: 9, files: 2 } },
  historyBackend: "loro",
  id: "sess-0001",
  isArchived: false,
  isWorktree: true,
  lastHandledUserMsgId: "msg-2",
  lastMessageAt: T0,
  lastModel: { modelId: "sonnet", name: "Sample Model 4" },
  lastReadAt: T0 - 60_000,
  latestUserMsgId: "msg-2",
  machineId: "machine-a",
  project: { kind: "github", repoFullName: "example-org/tidepool", branch: "main" },
  pullRequests: [
    { url: "https://github.com/example-org/tidepool/pull/311", status: "merged" },
    { url: "https://github.com/example-org/tidepool/pull/318", status: "draft" },
  ],
  "prLifecycle:machine:https://github.com/example-org/tidepool/pull/311": { s: "merged", u: T0 },
  repoFullName: "example-org/tidepool",
  status: { type: "idle" },
  title: "Retry with jitter",
  titleSource: "generated",
  userId: ME,
};

describe("what a command printed", () => {
  test("plain JSON, and JSON between log lines", () => {
    expect(parseCliJson('{"ok":true,"workspaces":[]}\n')).toEqual({ ok: true, workspaces: [] });
    const noisy = `[abc123] Remote Streams transport attached\n${JSON.stringify({ ok: true, machines: [{ id: "m" }] }, null, 2)}\n[abc123] Remote Streams transport detached\n`;
    expect(parseCliJson(noisy)).toEqual({ ok: true, machines: [{ id: "m" }] });
    expect(parseCliJson("\u001b[33m{\"ok\":false,\"error\":\"nope\"}\u001b[0m")).toEqual({ ok: false, error: "nope" });
    expect(parseCliJson("Exported 3 session(s)")).toBeUndefined();
    expect(parseCliJson("")).toBeUndefined();
  });

  test("an error is one clean line", () => {
    expect(cleanError("\u001b[31mError: Machine m-1 did not answer the cancel request.\u001b[0m\n    at cancel (index.js:1:1)")).toBe("Machine m-1 did not answer the cancel request.");
    expect(cleanError("x".repeat(500))).toHaveLength(240);
    expect(isSignedOutError("Not logged in. Run `lody login` first.")).toBe(true);
    expect(isSignedOutError("Session not found: abc")).toBe(false);
  });

  test("the device sign-in's page and code", () => {
    const printed = "  Machine Name: studio\n\n==================================================\nDevice Authorization\n\nPlease visit: \u001b[36mhttps://app.example/device?user_code=ABCD-1234\u001b[39m\nAttempting to open the URL in your default browser...";
    expect(parseLoginOutput(printed)).toEqual({ url: "https://app.example/device?user_code=ABCD-1234", code: "ABCD-1234" });
    expect(parseLoginOutput("Please visit: https://app.example/device.")).toEqual({ url: "https://app.example/device" });
    expect(parseLoginOutput("Initializing device authorization...")).toBeUndefined();
    // --debug names the servers before the page, and says when the code expires
    const debug = "[auth] server https://backend.example site https://app.example\nPlease visit: https://app.example/device?user_code=WXYZ-9876\n[device-auth] polling config: interval=5s (5000ms sleep) expires_in=600s deadline=2030-01-01T00:10:00.000Z";
    expect(parseLoginOutput(debug)).toEqual({ url: "https://app.example/device?user_code=WXYZ-9876", code: "WXYZ-9876", expiresAt: Date.parse("2030-01-01T00:10:00.000Z") });
    expect(parseLoginOutput("[auth] server https://backend.example")).toBeUndefined();
  });

  test("why a sign-in ended", () => {
    expect(loginFailure("✖ Authorization code expired")).toContain("expired");
    expect(loginFailure("✖ Authorization was denied")).toContain("refused");
    expect(loginFailure("Failed to request device code (HTTP 503): Service Unavailable")).toContain("could not be reached");
    expect(loginFailure("something else")).toBeUndefined();
  });

  test("the Node versions the CLI runs on", () => {
    expect(["v24.22.1", "v24.22.3", "v22.23.4", "v26.12.1", "26.13.0"].map(nodeRunsLody)).toEqual([true, true, true, true, true]);
    expect(["v24.15.0", "v22.23.3", "v23.9.0", "v25.1.0", "v20.19.0", "nonsense"].map(nodeRunsLody)).toEqual([false, false, false, false, false, false]);
  });
});

describe("workspaces, machines, agents, projects, roles", () => {
  test("workspace list", () => {
    expect(mapWorkspaces({ ok: true, workspaces: [{ id: "w1", name: "Example Team", slug: "example" }, { id: "w2", slug: "solo" }, { name: "no id" }, { id: "w3", name: "Vault", contentMode: "e2ee" }] })).toEqual([
      { id: "w1", name: "Example Team", slug: "example" },
      { id: "w2", name: "solo", slug: "solo" },
      { id: "w3", name: "Vault", locked: true },
    ]);
    expect(mapWorkspaces(undefined)).toEqual([]);
  });

  test("machine list --include-agents", () => {
    const json = {
      ok: true,
      workspaceId: "w1",
      machines: [
        { id: "machine-b", name: "build-box", online: false, onlineStatus: "offline", ownerUserId: "user-0002", agentConfigs: [{ id: "cfg-codex-b", machineId: "machine-b", name: "Codex", cliType: "builtin", agentType: "codex", env: {} }] },
        { id: "machine-a", name: "Studio", online: true, onlineStatus: "online", ownerUserId: ME, lastSeen: T0, agentConfigs: [{ id: "cfg-claude", machineId: "machine-a", name: "Claude", cliType: "builtin", agentType: "claude", env: {} }, { id: "cfg-fast", machineId: "machine-a", name: "Fast reviewer", cliType: "custom", agentType: "opencode" }] },
      ],
    };
    const { machines, agents } = mapMachines(json, { userId: ME });
    expect(machines).toEqual([
      { id: "machine-a", name: "Studio", online: true, mine: true },
      { id: "machine-b", name: "build-box", online: false },
    ]);
    expect(agents).toEqual([
      { id: "cfg-codex-b", name: "Codex", machineId: "machine-b" },
      { id: "cfg-claude", name: "Claude", machineId: "machine-a" },
      { id: "cfg-fast", name: "Fast reviewer", machineId: "machine-a", detail: "OpenCode" },
    ]);
    expect(agentName("pi-acp")).toBe("Pi");
    expect(agentName("somethingnew")).toBe("Somethingnew");
    expect(agentName(undefined)).toBeUndefined();
  });

  test("the project catalog, and the projects sessions name", () => {
    const catalog = { ok: true, items: [{ id: "example-org/tidepool", name: "tidepool", kind: "github", repoFullName: "example-org/tidepool" }, { id: "lp-1", name: "notebook", kind: "local", machineId: "machine-a", rootPath: "/work/notebook" }], projects: [{ id: "example-org/tidepool", name: "tidepool", kind: "github", repoFullName: "example-org/tidepool" }] };
    expect(mapProjects(catalog)).toEqual([
      { id: "gh:example-org/tidepool", name: "example-org/tidepool", kind: "github" },
      { id: "local:lp-1", name: "notebook", kind: "local", machineId: "machine-a" },
    ]);
    const metas = [META, { ...META, id: "s2", lastMessageAt: T0 + 5, repoFullName: undefined, project: { kind: "local", localProjectId: "lp-1" } }, { ...META, id: "s3", lastMessageAt: T0 - 5 }, { id: "s4", userId: ME }];
    expect(projectsOfSessions(metas)).toEqual([
      { id: "local:lp-1", name: "Local project", kind: "local", machineId: "machine-a" },
      { id: "gh:example-org/tidepool", name: "example-org/tidepool", kind: "github" },
    ]);
  });

  test("agent-role list", () => {
    expect(mapRoles({ ok: true, items: [{ id: "r1", name: "Reviewer", emoji: "🔎", description: "Reads a diff" }], roles: [{ id: "r1", name: "Reviewer", emoji: "🔎", description: "Reads a diff" }] })).toEqual([{ kind: "role", id: "r1", label: "🔎 Reviewer", detail: "Reads a diff" }]);
    expect(mapRoles({ ok: true, items: [], hasMore: false, roles: [] })).toEqual([]);
  });
});

describe("a session's row", () => {
  test("every field the catalog has", () => {
    expect(mapSessionRow(META, { userId: ME, preview: "Done." })).toEqual({
      id: "sess-0001",
      title: "Retry with jitter",
      state: "idle",
      createdAt: Date.parse("2026-11-18T07:00:00.000Z"),
      updatedAt: T0,
      unread: true,
      mine: true,
      machineId: "machine-a",
      agent: "Claude",
      model: "Sample Model 4",
      project: "example-org/tidepool",
      branch: "feat/retry-jitter",
      prs: [
        { url: "https://github.com/example-org/tidepool/pull/311", number: 311, state: "merged" },
        { url: "https://github.com/example-org/tidepool/pull/318", number: 318, state: "open", draft: true },
      ],
      preview: "Done.",
    });
  });

  test("unread, read marks, ownership, children", () => {
    expect(mapSessionRow({ ...META, lastReadAt: T0 })!.unread).toBeUndefined();
    expect(mapSessionRow({ ...META, lastReadAt: undefined })!.unread).toBe(true);
    expect(mapSessionRow(META, { readAt: T0 + 1 })!.unread).toBeUndefined();
    expect(mapSessionRow(META, { userId: "someone-else" })!.mine).toBeUndefined();
    const child = mapSessionRow({ ...META, id: "child", parentSessionId: "sess-0001", openedBySessionId: "sess-0001", isArchived: true, isPinned: true })!;
    expect(child).toMatchObject({ parentId: "sess-0001", archived: true, pinned: true });
    expect(child.openedById).toBeUndefined();
    expect(mapSessionRow({ ...META, id: "d", openedBySessionId: "sess-0001" })!.openedById).toBe("sess-0001");
    expect(mapSessionRow({ id: "bare", userId: ME, createdAt: "2026-11-18T07:00:00.000Z" })).toEqual({ id: "bare", title: "Untitled", state: "idle", createdAt: Date.parse("2026-11-18T07:00:00.000Z"), updatedAt: Date.parse("2026-11-18T07:00:00.000Z") });
    expect(mapSessionRow({ title: "no id" })).toBeUndefined();
    const local = mapSessionRow({ ...META, repoFullName: undefined, project: { kind: "local", localProjectId: "lp-1" } }, { projectName: (id) => (id === "lp-1" ? "notebook" : undefined) })!;
    expect(local.project).toBe("notebook");
  });

  test("the state: the observation when it read the history, else the catalog", () => {
    const seen = (state: string, latest?: string) => ({ state: state as "idle", source: "persisted", activeTurns: [], ...(latest ? { latestTurn: { state: latest } } : {}) });
    expect(sessionState(META)).toBe("idle");
    expect(sessionState({ ...META, status: { type: "running" } })).toBe("running");
    expect(sessionState({ ...META, status: { type: "requestPermission" } })).toBe("waiting");
    expect(sessionState({ ...META, status: { type: "initializing", stage: "git-clone" } })).toBe("starting");
    expect(sessionState({ ...META, lastFailedUserMsgId: "msg-2" })).toBe("failed");
    expect(sessionState({ ...META, lastFailedUserMsgId: "msg-1" })).toBe("idle");
    expect(sessionState({ ...META, status: { type: "running" } }, seen("unknown"))).toBe("running");
    expect(sessionState(META, seen("running"))).toBe("running");
    // a catalog "running" with nothing said for two months is a machine that stopped mid-turn
    const old = { ...META, status: { type: "running" }, lastMessageAt: 1_000 };
    expect(sessionState(old, undefined, 1_000 + 60 * 24 * 3600 * 1000)).toBe("idle");
    expect(sessionState(old, undefined, 1_000 + 3600 * 1000)).toBe("running");
    expect(sessionState(old, seen("running"), 1_000 + 60 * 24 * 3600 * 1000)).toBe("idle");
    expect(sessionState(old, seen("running"), 1_000 + 3600 * 1000)).toBe("running");
    expect(sessionState(META, seen("pending"))).toBe("starting");
    expect(sessionState(META, seen("waiting"))).toBe("waiting");
    expect(sessionState({ ...META, status: { type: "running" } }, seen("idle", "completed"))).toBe("idle");
    expect(sessionState(META, seen("idle", "failed"))).toBe("failed");
  });

  test("a snapshot's rows are capped, newest first, a child with its parent", () => {
    const rows = Array.from({ length: 300 }, (_, at) => ({ id: `s${at}`, title: "t", state: "idle" as const, createdAt: at, updatedAt: at, ...(at < 100 ? { archived: true } : {}) }));
    rows[250] = { ...rows[250]!, parentId: "s3" } as (typeof rows)[number];
    const kept = capRows(rows, 250, 10);
    expect(kept.slice(0, 3).map((row) => row.id)).toEqual(["s299", "s298", "s297"]);
    expect(kept.filter((row) => row.archived).map((row) => row.id)).toEqual(["s99", "s98", "s97", "s96", "s95", "s94", "s93", "s92", "s91", "s90", "s3"]);
    expect(kept).toHaveLength(211);
    // past the cap the oldest go, whatever they are
    expect(capRows(rows, 120, 10).map((row) => row.id)).toEqual([...Array.from({ length: 120 }, (_, at) => `s${299 - at}`), "s3"]);
  });
});

describe("session observe --jsonl", () => {
  test("its events", () => {
    const envelope = { version: 1, streamId: "x", sequence: 4, observedAt: T0, workspaceId: "w1" };
    expect(parseObserveLine(JSON.stringify({ ...envelope, type: "snapshot", sessionId: "s1", session: { sessionId: "s1", machineId: "m", title: "Hello", archived: false, state: "running", freshness: "synced", source: "persisted", latestTurn: { userTurnId: "u1", assistantTurnId: "a1", state: "running" }, activeTurns: [{ userTurnId: "u1", assistantTurnId: "a1", state: "running" }] } }))).toEqual({
      type: "snapshot",
      sessionId: "s1",
      session: { state: "running", source: "persisted", title: "Hello", archived: false, latestTurn: { userTurnId: "u1", assistantTurnId: "a1", state: "running" }, activeTurns: [{ userTurnId: "u1", assistantTurnId: "a1", state: "running" }] },
    });
    expect(parseObserveLine(JSON.stringify({ ...envelope, type: "turn.finished", sessionId: "s1", userTurnId: "u1", assistantTurnId: "a1", outcome: "completed", durationMs: 4200 }))).toEqual({ type: "turn.finished", sessionId: "s1", userTurnId: "u1", assistantTurnId: "a1", outcome: "completed", durationMs: 4200 });
    expect(parseObserveLine(JSON.stringify({ ...envelope, type: "ready" }))).toEqual({ type: "ready" });
    expect(parseObserveLine(JSON.stringify({ ...envelope, type: "session.removed", sessionId: "s1" }))).toEqual({ type: "session.removed", sessionId: "s1" });
    expect(parseObserveLine('{"type":"error","error":"Workspace not found: nope"}')).toEqual({ type: "error", error: "Workspace not found: nope" });
    expect(parseObserveLine(JSON.stringify({ ...envelope, type: "session.changed", sessionId: "s1", session: { state: "strange" } }))).toEqual({ type: "session.changed", sessionId: "s1", session: { state: "unknown", activeTurns: [] } });
    expect(parseObserveLine("[abc] Remote Streams transport attached")).toBeUndefined();
    expect(parseObserveLine('{"type":"snapshot"}')).toBeUndefined();
    expect(parseObserveLine('{"type":"future.event","sessionId":"s1"}')).toBeUndefined();
  });
});

const HISTORY = {
  ok: true,
  workspaceId: "w1",
  sessionId: "sess-0001",
  total: 5,
  returned: 5,
  entries: [
    { index: 0, id: "msg-1", role: "user", author: { v: 1, kind: "human", userId: ME }, timestamp: "2026-11-18T07:00:00.000Z", text: "把重试改成指数退避" },
    { index: 3, id: "turn-1", role: "assistant", author: { v: 1, kind: "agent", sessionId: "sess-0001", turnId: "turn-1", name: "Claude" }, timestamp: "2026-11-18T07:02:00.000Z", text: "改好了，测试通过。" },
    { index: 4, id: "msg-2", role: "user", author: { v: 1, kind: "agent", sessionId: "sess-0009", turnId: "t", name: "Planner" }, timestamp: "2026-11-18T07:05:00.000Z", text: "Also make max attempts configurable." },
    { index: 6, id: "sys-1", role: "system", timestamp: "2026-11-18T07:06:00.000Z", text: JSON.stringify({ type: "operation_completion", deliveryId: "d", operationId: "o", operationKind: "session_create", completion: { type: "result", value: {} } }) },
    { index: 7, id: "turn-2", role: "assistant", timestamp: "2026-11-18T07:08:00.000Z", text: "`max_attempts` is in the policy now." },
  ],
};

describe("session history --json", () => {
  test("an idle session: messages, each turn's last text, a notice, the latest turn's end", () => {
    const items = mapHistory(HISTORY, { sessionId: "sess-0001", userId: ME, userName: "Owner", state: "idle", model: "Sample Model 4", observed: { state: "idle", source: "persisted", activeTurns: [], latestTurn: { userTurnId: "msg-2", assistantTurnId: "turn-2", state: "completed", durationMs: 61_000 } } });
    expect(items).toEqual([
      { k: "user", id: "msg-1", turn: "msg-1", at: Date.parse("2026-11-18T07:00:00.000Z"), text: "把重试改成指数退避", author: "Owner", mine: true },
      { k: "text", id: "turn-1", turn: "msg-1", at: Date.parse("2026-11-18T07:02:00.000Z"), text: "改好了，测试通过。", final: true },
      { k: "user", id: "msg-2", turn: "msg-2", at: Date.parse("2026-11-18T07:05:00.000Z"), text: "Also make max attempts configurable.", author: "Planner" },
      { k: "notice", id: "sys-1", turn: "msg-2", at: Date.parse("2026-11-18T07:06:00.000Z"), tone: "done", text: "A delegated task finished." },
      { k: "text", id: "turn-2", turn: "msg-2", at: Date.parse("2026-11-18T07:08:00.000Z"), text: "`max_attempts` is in the policy now.", final: true },
      { k: "turn-end", id: "turn-2:end", turn: "msg-2", at: Date.parse("2026-11-18T07:08:00.000Z"), outcome: "completed", durationMs: 61_000, model: "Sample Model 4" },
    ]);
  });

  test("a running session: the last text is still being written, and nothing has ended", () => {
    const items = mapHistory(HISTORY, { sessionId: "sess-0001", userId: ME, state: "running" });
    expect(items.at(-1)).toEqual({ k: "text", id: "turn-2", turn: "msg-2", at: Date.parse("2026-11-18T07:08:00.000Z"), text: "`max_attempts` is in the policy now.", streaming: true });
    expect(items.some((item) => item.k === "turn-end")).toBe(false);
    expect(items[1]).toMatchObject({ k: "text", final: true });
  });

  test("a waiting session says where to answer; a failed one says so", () => {
    const waiting = mapHistory(HISTORY, { sessionId: "sess-0001", state: "waiting" });
    expect(waiting.at(-1)).toMatchObject({ k: "notice", id: "sess-0001:waiting", tone: "info" });
    expect((waiting.at(-1) as { text: string }).text).toContain("Answer it in Lody on a phone or computer");
    const failed = mapHistory(HISTORY, { sessionId: "sess-0001", state: "failed" });
    expect(failed.slice(-2).map((item) => item.k)).toEqual(["notice", "turn-end"]);
    expect(failed.at(-1)).toMatchObject({ outcome: "failed" });
    expect(failed.at(-2)).toMatchObject({ tone: "error", id: "sess-0001:failed" });
  });

  test("an entry without an author is its session's owner's; an empty history is empty", () => {
    const bare = { entries: [{ index: 0, id: "m", role: "user", timestamp: "2026-11-18T07:00:00.000Z", text: "hi" }] };
    expect(mapHistory(bare, { sessionId: "s", userId: ME, ownerId: ME, state: "idle" })[0]).toMatchObject({ mine: true });
    expect(mapHistory(bare, { sessionId: "s", userId: ME, ownerId: "other", state: "idle" })[0]).not.toHaveProperty("mine");
    expect(mapHistory({ entries: [] }, { sessionId: "s", state: "idle" })).toEqual([]);
    expect(mapHistory(undefined, { sessionId: "s", state: "failed" })).toEqual([]);
  });

  test("an old turn's end is not put on a newer turn", () => {
    const items = mapHistory(HISTORY, { sessionId: "sess-0001", state: "idle", observed: { state: "idle", activeTurns: [], latestTurn: { userTurnId: "msg-1", assistantTurnId: "turn-1", state: "completed" } } });
    expect(items.some((item) => item.k === "turn-end")).toBe(false);
  });
});

describe("lody export's transcript.json", () => {
  const EXPORT = {
    session: { sessionId: "sess-0001", title: "Retry with jitter" },
    turns: [
      { turnId: "msg-1", role: "user", timestamp: "2026-11-18T07:00:00.000Z", finished: true, startedAt: null, endedAt: null, modelInfo: null, items: [{ type: "text", text: "Make the retry exponential" }, { type: "image", imageId: "i1", mimeType: "image/png" }] },
      {
        turnId: "turn-1",
        role: "assistant",
        timestamp: "2026-11-18T07:00:05.000Z",
        finished: true,
        startedAt: T0,
        endedAt: T0 + 95_000,
        modelInfo: { modelId: "sonnet", name: "Sample Model 4" },
        items: [
          { type: "thought", text: "Look at retry.rs first." },
          { type: "plan", entries: [{ content: "Read the code", status: "completed", priority: "medium" }, { content: "Change it", status: "in_progress", priority: "medium" }, { content: "Test", status: "pending", priority: "low" }] },
          { type: "text", text: "Reading the retry code.", messagePhase: "commentary" },
          { type: "tool_call", toolCallId: "t1", title: "Read retry.rs", kind: "read", status: "completed", toolName: "Read", locations: [{ path: "/work/tidepool/src/retry.rs", line: 1 }], content: [] },
          { type: "tool_call", toolCallId: "t2", title: "cargo test", kind: "execute", status: "completed", toolName: "Bash", content: [{ type: "terminal_command", command: "cargo", args: ["test", "-p", "engine"] }, { type: "terminal_output", output: "running 6 tests\ntest result: ok. 6 passed\n", exitStatus: { exitCode: 0 } }], permissionRequest: { requestId: "perm-1", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }], outcome: { outcome: "selected", optionId: "always" } } },
          { type: "tool_call", toolCallId: "t3", title: "Fetch docs", kind: "fetch", status: "failed", content: [{ type: "content", content: { type: "text", text: "404 Not Found" } }] },
          { type: "subagent_task", taskId: "k1", status: "completed", description: "Review the change", summary: "No issues found" },
          { type: "system_notice", name: "agent_warning", meta: { message: "Context is 80% full", source: "agent" } },
          { type: "text", text: "Done: **exponential backoff** with jitter.", messagePhase: "final_answer" },
        ],
      },
      { turnId: "msg-2", role: "user", timestamp: "2026-11-18T07:10:00.000Z", finished: true, items: [{ type: "text", text: "Push it" }] },
      { turnId: "turn-2", role: "assistant", timestamp: "2026-11-18T07:10:05.000Z", finished: false, startedAt: T0 + 600_000, endedAt: null, modelInfo: null, items: [{ type: "tool_call", toolCallId: "t4", title: "git push", kind: "execute", status: "in_progress", toolName: "Bash", content: [{ type: "terminal_command", command: "git push" }], permissionRequest: { requestId: "perm-2", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } }, { type: "system_notice", name: "chat_failed", meta: { message: "The agent exited", reason: "crash" } }] },
    ],
  };

  test("every item of a finished turn", () => {
    const items = mapExportTranscript(EXPORT, { userId: ME, userName: "Owner", ownerId: ME });
    const first = items.filter((item) => item.turn === "msg-1");
    expect(first.map((item) => `${item.k}${item.k === "tool" ? `:${item.kind}:${item.status}` : ""}`)).toEqual(["user", "thought", "plan", "text", "tool:read:done", "tool:execute:done", "ask", "tool:fetch:failed", "tool:delegate:done", "notice", "text", "turn-end"]);
    expect(first[0]).toEqual({ k: "user", id: "msg-1", turn: "msg-1", at: Date.parse("2026-11-18T07:00:00.000Z"), text: "Make the retry exponential", author: "Owner", mine: true, attachments: 1 });
    expect(first[2]).toMatchObject({ entries: [{ text: "Read the code", status: "done" }, { text: "Change it", status: "running" }, { text: "Test", status: "pending" }] });
    expect(first[4]).toMatchObject({ title: "Read retry.rs", detail: "/work/tidepool/src/retry.rs" });
    expect(first[5]).toMatchObject({ detail: "cargo test -p engine", output: "running 6 tests\ntest result: ok. 6 passed" });
    expect(first[6]).toEqual({ id: "turn-1:4:ask", turn: "msg-1", at: Date.parse("2026-11-18T07:00:05.000Z"), k: "ask", requestId: "perm-1", title: "cargo test", detail: "cargo test -p engine", options: [{ id: "allow", label: "Allow", kind: "allow" }, { id: "always", label: "Always allow", kind: "allow-always" }, { id: "deny", label: "Deny", kind: "reject" }], outcome: "Always allow" });
    expect(first[7]).toMatchObject({ output: "404 Not Found" });
    expect(first[8]).toMatchObject({ title: "Review the change", output: "No issues found" });
    expect(first[9]).toMatchObject({ tone: "info", text: "Context is 80% full" });
    expect(first[10]).toMatchObject({ k: "text", final: true });
    expect(first[3]).not.toHaveProperty("final");
    expect(first[11]).toEqual({ id: "turn-1:end", turn: "msg-1", at: T0 + 95_000, k: "turn-end", outcome: "completed", durationMs: 95_000, model: "Sample Model 4" });
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  test("a turn that is still going keeps its open call and its open request", () => {
    const live = mapExportTranscript(EXPORT, { busy: true }).filter((item) => item.turn === "msg-2");
    expect(live.map((item) => item.k)).toEqual(["user", "tool", "ask", "notice"]);
    expect(live[1]).toMatchObject({ status: "running" });
    expect(live[2]).not.toHaveProperty("outcome");
    const ended = mapExportTranscript(EXPORT).filter((item) => item.turn === "msg-2");
    expect(ended[1]).toMatchObject({ status: "failed" });
    expect(ended[2]).toMatchObject({ outcome: "Not answered" });
    expect(ended[3]).toMatchObject({ tone: "error", text: "The turn failed: The agent exited" });
  });
});

describe("what is sent", () => {
  test("@ tokens become what Lody reads", () => {
    const text = "see @Retry and ask @Reviewer about @src/a.rs";
    const mentions = [
      { start: 4, end: 10, kind: "session" as const, id: "sess-0001" },
      { start: 19, end: 28, kind: "role" as const, id: "role-1" },
      { start: 35, end: 44, kind: "file" as const, id: "src/a.rs" },
    ];
    expect(mentionText(text, mentions, { workspaceId: "w1", sessionTitle: () => "Retry [with] jitter", roleName: () => "Reviewer" })).toBe("see [@Retry with jitter](lody://session/sess-0001?workspace=w1) and ask [Agent Role: Reviewer (agentRoleId: role-1)] about @src/a.rs");
    expect(mentionText(text, [{ start: 400, end: 410, kind: "session", id: "x" }], { sessionTitle: () => undefined, roleName: () => undefined })).toBe(text);
    expect(mentionText(text, undefined, { sessionTitle: () => undefined, roleName: () => undefined })).toBe(text);
  });
});
