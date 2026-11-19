// pocket-lody/service/fixture.ts — a driver with a sample workspace and no
// network, for tests, screenshots and a demo.
//
// The data is fixture-data.ts. This file makes it live: a message sent to a
// session is answered over the next seconds the way an agent would — the
// session runs, thinks, calls a tool, writes its answer a piece at a time
// and ends its turn. Time is the fixture's own: `advance(ms)` moves it, and
// the steps that fall due run in order. With `auto`, a timer advances it with
// the real clock. Nothing is random, so the same `now` and the same calls
// give the same bytes.

import type { ActionResponse, AskOption, CreateOptions, Item, Link, MentionRow, SessionRow, SessionState } from "../protocol.ts";
import { Changes, OK, refuse, type BackendCreate, type BackendSend, type BackendSnapshot, type BackendTranscript, type LodyBackend, type MentionQuery } from "./backend.ts";
import { qrRows } from "./qr.ts";
import { AGENTS, FILES, MACHINES, ME, PROJECTS, ROLES, STREAM_TAIL, WORKSPACES, buildFixture, oneLine, previewOf } from "./fixture-data.ts";

export interface FixtureOptions {
  /** the fixture's time at its start; default the real clock's */
  now?: number;
  /** advance with the real clock, for a demo; tests call `advance` */
  auto?: boolean;
  /** `Link.via` */
  via?: string;
  /** Where the fixture starts, to show what a device goes through before it
   *  has an account: "setup" offers `link.setup` over the sample data (and
   *  /setup then takes about six seconds and ends signed out), "signed-out"
   *  starts at the sign-in. Default: signed in. */
  start?: "setup" | "signed-out";
  /** the name the device signs in as, as a handheld's config gives it */
  machine?: string;
}

export interface FixtureBackend extends LodyBackend {
  /** Moves the fixture's time on by `ms`, running the steps that fall due. */
  advance(ms: number): void;
  now(): number;
}

/** How long a simulated turn takes from the message to the turn's end. */
export const FIXTURE_TURN_MS = 7400;
export const FIXTURE_SIGNIN = { url: "https://lody.example/device?user_code=LNTN-4821", code: "LNTN-4821" };
const FIXTURE_QR = qrRows(FIXTURE_SIGNIN.url)!;

interface Live {
  workspace: string;
  row: SessionRow;
  items: Item[];
  activeTurn?: string;
  /** user items waiting for the turn in progress to end */
  queue: string[];
  turnStarted?: number;
}

interface Step {
  at: number;
  seq: number;
  session: string;
  run: () => void;
}

const CJK = /[㐀-鿿]/;
const NEEDS_PERMISSION = /\b(deploy|push|publish|delete|rm)\b|部署|推送|发布|删除/i;

const PERMISSION = (zh: boolean): AskOption[] => [
  { id: "allow", label: zh ? "允许一次" : "Allow once", kind: "allow" },
  { id: "allow-always", label: zh ? "始终允许" : "Always allow", kind: "allow-always" },
  { id: "reject", label: zh ? "拒绝" : "Reject", kind: "reject" },
];

/** What the pretend agent says to `prompt`. */
function replyTo(prompt: string) {
  const zh = CJK.test(prompt);
  const topic = oneLine(prompt, 36);
  const risky = NEEDS_PERMISSION.test(prompt);
  const command = risky ? "git push origin HEAD" : `rg -n "${(prompt.match(/[A-Za-z_][A-Za-z0-9_]{3,}/) ?? ["TODO"])[0]}" src | head -5`;
  return {
    zh,
    risky,
    thought: zh ? `用户想要：${topic}。先看相关代码，再决定改哪里。` : `The request: ${topic}. Look at the code involved before changing anything.`,
    tool: { title: risky ? (zh ? "推送到远端" : "Push to the remote") : zh ? "搜索代码" : "Search the code", detail: command },
    output: risky ? "To git.example:lantern-labs/sample.git\n   4c1e2aa..9f3b7d0  HEAD -> main" : "src/sync/queue.ts:41:export function shouldRetry(attempt: number, limit = 5) {\nsrc/sync/queue.ts:88:  if (!shouldRetry(batch.attempt)) return drop(batch);\nsrc/sync/index.ts:12:export { shouldRetry } from \"./queue\";",
    text: zh
      ? `关于“${topic}”，我看完了，结论如下：\n\n1. 入口在 \`src/sync/queue.ts\`，现有的钩子已经够用\n2. 我加了一个保护：空批次直接跳过，不再重试\n\n\`\`\`ts\nexport function shouldRetry(attempt: number, limit = 5): boolean {\n  return attempt < limit;\n}\n\`\`\`\n\n本地测试通过（\`bun test\`，42 个）。需要我把它放到开关后面吗？`
      : `Here is what I found for “${topic}”:\n\n1. The entry point is \`src/sync/queue.ts\`; the hook it exposes is enough.\n2. I added a guard: an empty batch is skipped instead of retried.\n\n\`\`\`ts\nexport function shouldRetry(attempt: number, limit = 5): boolean {\n  return attempt < limit;\n}\n\`\`\`\n\nTests pass locally (\`bun test\`, 42 passed). Do you want this behind a flag?`,
  };
}

/** `text` in `count` pieces that join back to it, cut between characters. */
function pieces(text: string, count: number): string[] {
  const letters = Array.from(text);
  const out: string[] = [];
  for (let at = 0; at < count; at++) out.push(letters.slice(Math.floor((at * letters.length) / count), Math.floor(((at + 1) * letters.length) / count)).join(""));
  return out;
}

export function createFixtureBackend(options: FixtureOptions = {}): FixtureBackend {
  const changes = new Changes();
  let time = options.now ?? Date.now();
  const sessions = new Map<string, Live>();
  for (const session of buildFixture(time)) sessions.set(session.row.id, { workspace: session.workspace, row: session.row, items: session.items, queue: [], ...(session.activeTurn ? { activeTurn: session.activeTurn, turnStarted: session.items.find((item) => item.id === session.activeTurn)?.at ?? time } : {}) });
  let workspaceId = WORKSPACES[0]!.id;
  let phase: Link["phase"] = options.start === "signed-out" ? "signed-out" : "ready";
  let setup: Link["setup"] | undefined = options.start === "setup" ? { state: "needed" } : undefined;
  let signinExpires = 0;
  const machine = options.machine ?? "Sample handheld";
  let made = 0;
  let ids = 0;
  let closed = false;

  // --- time -----------------------------------------------------------------
  let steps: Step[] = [];
  let seq = 0;

  function after(session: string, ms: number, run: () => void) {
    steps.push({ at: time + ms, seq: seq++, session, run });
  }

  function advance(ms: number) {
    if (closed || !(ms > 0)) return;
    const target = time + ms;
    for (;;) {
      let due: Step | undefined;
      for (const step of steps) if (step.at <= target && (!due || step.at < due.at || (step.at === due.at && step.seq < due.seq))) due = step;
      if (!due) break;
      steps = steps.filter((step) => step !== due);
      time = Math.max(time, due.at);
      due.run();
    }
    time = target;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.auto) {
    let last = Date.now();
    timer = setInterval(() => {
      const real = Date.now();
      advance(real - last);
      last = real;
    }, 200);
    (timer as { unref?: () => void }).unref?.();
  }

  // --- changing a session -----------------------------------------------------
  const nextId = (session: Live) => `${session.row.id}:n${++ids}`;

  function touched(session: Live, when = time) {
    const preview = previewOf(session.items);
    session.row = { ...session.row, updatedAt: Math.max(session.row.updatedAt, when), ...(preview ? { preview } : {}) };
    changes.session(session.row.id);
    changes.snapshot();
  }

  function append(session: Live, item: Record<string, unknown> & { k: Item["k"] }, turn = session.activeTurn ?? ""): string {
    const id = (item.id as string | undefined) ?? nextId(session);
    session.items = [...session.items, { ...item, id, turn: item.k === "user" ? id : turn, at: time } as Item];
    touched(session);
    return id;
  }

  function patch(session: Live, id: string, change: (item: Item) => Item) {
    session.items = session.items.map((item) => (item.id === id ? change(item) : item));
    touched(session);
  }

  function setState(session: Live, state: SessionState) {
    if (session.row.state === state) return;
    session.row = { ...session.row, state };
    changes.session(session.row.id);
    changes.snapshot();
  }

  function setRow(session: Live, fields: Partial<SessionRow>) {
    session.row = { ...session.row, ...fields };
    changes.session(session.row.id);
    changes.snapshot();
  }

  const machineOf = (session: Live) => (MACHINES[session.workspace] ?? []).find((machine) => machine.id === session.row.machineId);
  const busy = (session: Live) => session.row.state === "running" || session.row.state === "starting" || session.row.state === "waiting";
  const drop = (session: Live) => {
    steps = steps.filter((step) => step.session !== session.row.id);
  };

  // --- a turn -----------------------------------------------------------------
  function endTurn(session: Live, outcome: "completed" | "failed" | "canceled") {
    append(session, { k: "turn-end", outcome, durationMs: Math.max(0, time - (session.turnStarted ?? time)), model: session.row.model ?? "Claude Sonnet 4.5" });
    session.activeTurn = undefined;
    session.turnStarted = undefined;
    setRow(session, { state: "idle", ...(outcome === "completed" ? { unread: true } : {}) });
    const queued = session.queue.shift();
    if (queued) {
      const item = session.items.find((entry) => entry.id === queued);
      if (item?.k === "user") startTurn(session, queued, item.text);
    }
  }

  /** The answer, written a piece at a time from `delay` on, then the turn's end. */
  function streamAnswer(session: Live, text: string, delay: number, count = 5) {
    const id = session.row.id;
    const parts = pieces(text, count);
    let textId = "";
    let written = "";
    parts.forEach((part, at) => {
      after(id, delay + at * 600, () => {
        written += part;
        const last = at === parts.length - 1;
        if (!textId) textId = append(session, { k: "text", text: written, streaming: true });
        else patch(session, textId, (item) => (item.k === "text" ? { id: item.id, turn: item.turn, at: item.at, k: "text", text: written, ...(last ? { final: true } : { streaming: true }) } : item));
      });
    });
    after(id, delay + (parts.length - 1) * 600 + 300, () => endTurn(session, "completed"));
  }

  function runTool(session: Live, toolId: string, output: string, text: string, delay: number) {
    const id = session.row.id;
    after(id, delay, () => {
      setState(session, "running");
      patch(session, toolId, (item) => (item.k === "tool" ? { ...item, status: "running" } : item));
    });
    after(id, delay + 1200, () => patch(session, toolId, (item) => (item.k === "tool" ? { ...item, status: "done", output } : item)));
    streamAnswer(session, text, delay + 1800);
  }

  function startTurn(session: Live, userId: string, prompt: string) {
    const id = session.row.id;
    const reply = replyTo(prompt);
    session.activeTurn = userId;
    session.turnStarted = time;
    after(id, 300, () => {
      patch(session, userId, (item) => {
        if (item.k !== "user") return item;
        const { delivery: _sent, ...rest } = item;
        return rest;
      });
      setState(session, "running");
    });
    after(id, 900, () => append(session, { k: "thought", text: reply.thought }));
    after(id, 1500, () => {
      const toolId = append(session, { k: "tool", kind: "execute", title: reply.tool.title, status: "pending", detail: reply.tool.detail });
      if (!reply.risky) return runTool(session, toolId, reply.output, reply.text, 500);
      after(id, 300, () => {
        append(session, { k: "ask", requestId: `${toolId}:req`, title: reply.zh ? `允许执行 ${reply.tool.detail} 吗？` : `Allow ${reply.tool.detail}?`, detail: reply.tool.detail, options: PERMISSION(reply.zh) });
        setState(session, "waiting");
      });
    });
  }

  // --- what was already happening at the start -------------------------------
  {
    const streaming = sessions.get("s-sync-retry");
    const text = streaming?.items[streaming.items.length - 1];
    const tool = streaming?.items.find((item) => item.k === "tool" && item.status === "running");
    const plan = streaming?.items.find((item) => item.k === "plan");
    if (streaming && text?.k === "text" && tool && plan?.k === "plan") {
      const id = streaming.row.id;
      STREAM_TAIL.forEach((tail, at) => after(id, 1500 * (at + 1), () => patch(streaming, text.id, (item) => (item.k === "text" ? { ...item, text: item.text + tail } : item))));
      after(id, 2200, () => patch(streaming, tool.id, (item) => (item.k === "tool" ? { ...item, status: "done", output: `${item.output}\ntest retry::tests::policy_default_is_sane ... ok\n\ntest result: ok. 6 passed; 0 failed; 0 ignored` } : item)));
      after(id, 6400, () => patch(streaming, plan.id, (item) => (item.k === "plan" ? { ...item, entries: item.entries.map((entry) => ({ ...entry, status: "done" as const })) } : item)));
      after(id, 6800, () => patch(streaming, text.id, (item) => (item.k === "text" ? { id: item.id, turn: item.turn, at: item.at, k: "text", text: item.text, final: true } : item)));
      after(id, 7200, () => endTurn(streaming, "completed"));
    }
    const fresh = sessions.get("s-starting");
    const first = fresh?.items[0];
    if (fresh && first?.k === "user") after(fresh.row.id, 20_000, () => startTurn(fresh, first.id, first.text));
  }

  // --- the driver -------------------------------------------------------------
  // the link says what the `cli` driver's does on a device with an account of its own
  const link = (): Link => {
    const base = { driver: "fixture", ...(options.via ? { via: options.via } : {}), ownAccount: true };
    if (phase === "ready") return { ...base, phase, user: ME, ...(setup ? { setup } : {}) };
    if (phase === "signing-in") return { ...base, phase, ...FIXTURE_SIGNIN, qr: FIXTURE_QR, expiresAt: signinExpires, machine, detail: "Open the page on a phone or a computer and confirm the code to finish signing in." };
    return { ...base, phase, machine, detail: `${machine} is not signed in to Lody. Sign in to see your sessions.` };
  };

  async function snapshot(): Promise<BackendSnapshot> {
    if (phase !== "ready") return { link: link(), workspaces: [], machines: [], sessions: [] };
    return {
      link: link(),
      workspaces: WORKSPACES,
      workspaceId,
      machines: MACHINES[workspaceId] ?? [],
      sessions: [...sessions.values()].filter((session) => session.workspace === workspaceId).map((session) => session.row),
    };
  }

  const known = (sessionId: string) => (phase === "ready" ? sessions.get(sessionId) : undefined);
  const NO_SESSION = "That session is not in this workspace any more; go back and pick another.";

  async function transcript(sessionId: string): Promise<BackendTranscript | null> {
    const session = known(sessionId);
    if (!session) return null;
    const online = machineOf(session)?.online !== false;
    return {
      state: session.row.state,
      can: { send: online && !session.row.archived, cancel: busy(session), answer: session.items.some((item) => item.k === "ask" && item.outcome === undefined) },
      ...(session.activeTurn ? { activeTurn: session.activeTurn } : {}),
      items: session.items,
      complete: true,
    };
  }

  async function send(request: BackendSend): Promise<ActionResponse> {
    const session = known(request.session);
    if (!session) return refuse(phase === "ready" ? NO_SESSION : "Sign in before sending a message.");
    if (session.row.archived) return refuse("This session is archived; restore it before sending to it.");
    const machine = machineOf(session);
    if (machine && !machine.online) return refuse(`${machine.name} is offline, so the message cannot reach it. Wake that computer, or start a session on another.`);
    const waits = busy(session) && !request.steer;
    const userId = append(session, { k: "user", text: request.text, author: ME.name, mine: true, delivery: waits ? "queued" : busy(session) ? undefined : "sending" });
    setRow(session, { unread: false });
    if (waits) session.queue.push(userId);
    else if (!busy(session)) startTurn(session, userId, request.text);
    return OK;
  }

  async function create(request: BackendCreate): Promise<ActionResponse> {
    if (phase !== "ready") return refuse("Sign in before starting a session.");
    const target = request.workspace ?? workspaceId;
    const machine = (MACHINES[target] ?? []).find((entry) => entry.id === request.machine);
    if (!machine) return refuse("That computer is not in this workspace; pick one from the list.");
    if (!machine.online) return refuse(`${machine.name} is offline; pick another computer or wake it.`);
    const agent = AGENTS.find((entry) => entry.id === request.agent && entry.machineId === machine.id);
    if (!agent) return refuse(`That agent is not set up on ${machine.name}; pick one from the list.`);
    const project = request.project ? PROJECTS.find((entry) => entry.id === request.project) : undefined;
    if (request.project && !project) return refuse("That project is not in this workspace; pick one from the list.");
    const id = `s-new-${++made}`;
    const row: SessionRow = { id, title: request.title?.trim() || oneLine(request.text, 48), state: "starting", createdAt: time, updatedAt: time, mine: true, machineId: machine.id, agent: agent.name, model: agent.detail, ...(project && project.kind !== "chat" ? { project: project.name } : {}), ...(request.branch ? { branch: request.branch } : {}) };
    const session: Live = { workspace: target, row, items: [], queue: [] };
    sessions.set(id, session);
    const userId = append(session, { k: "user", text: request.text, author: ME.name, mine: true, delivery: "sending" });
    if (project && project.kind !== "chat") append(session, { k: "notice", tone: "info", text: `Preparing the workspace: ${project.kind === "github" ? `cloning ${project.name}` : `opening ${project.name}`}…` }, userId);
    after(id, 1200, () => startTurn(session, userId, request.text));
    return { ok: true, session: id };
  }

  async function cancel(sessionId: string): Promise<ActionResponse> {
    const session = known(sessionId);
    if (!session) return refuse(NO_SESSION);
    if (!busy(session)) return OK;
    drop(session);
    const turn = session.activeTurn;
    session.items = session.items.map((item): Item => {
      if (item.turn !== turn) return item;
      if (item.k === "text" && item.streaming) return { id: item.id, turn: item.turn, at: item.at, k: "text", text: item.text };
      if (item.k === "tool" && (item.status === "pending" || item.status === "running")) return { ...item, status: "failed" };
      if (item.k === "ask" && item.outcome === undefined) return { ...item, outcome: "Cancelled" };
      if (item.k === "user" && item.delivery === "sending") return { id: item.id, turn: item.turn, at: item.at, k: "user", text: item.text, ...(item.author ? { author: item.author } : {}), ...(item.mine ? { mine: true } : {}) };
      return item;
    });
    endTurn(session, "canceled");
    return OK;
  }

  async function answer(request: { session: string; requestId: string; option: string; text?: string }): Promise<ActionResponse> {
    const session = known(request.session);
    if (!session) return refuse(NO_SESSION);
    const ask = session.items.find((item) => item.k === "ask" && item.requestId === request.requestId);
    if (!ask || ask.k !== "ask") return refuse("That request is no longer in the conversation; open the session again.");
    if (ask.outcome !== undefined) return refuse("That request was already answered.");
    const option = ask.options.find((entry) => entry.id === request.option);
    if (!option) return refuse("That is not one of the request's options; pick one that is shown.");
    const zh = CJK.test(ask.title);
    patch(session, ask.id, (item) => (item.k === "ask" ? { ...item, outcome: request.text ? `${option.label}: ${request.text}` : option.label } : item));
    session.activeTurn ??= ask.turn;
    session.turnStarted ??= ask.at;
    if (ask.question) {
      setState(session, "running");
      const chosen = request.text ? `${option.label}（${request.text}）` : option.label;
      streamAnswer(session, zh ? `好的，按 **${chosen}** 来。\n\n接下来我会：\n\n1. 写出对应的迁移脚本\n2. 在预发环境用 1% 的数据演练一遍\n3. 把回滚步骤写进同一个 PR\n\n脚本准备好后我再请你过目。` : `Understood: **${chosen}**.\n\nNext I will:\n\n1. write the migration for that choice\n2. rehearse it on staging with 1% of the data\n3. put the rollback steps in the same PR\n\nI'll ask you to look before anything runs for real.`, 600, 4);
      return OK;
    }
    const tool = [...session.items].reverse().find((item) => item.k === "tool" && item.turn === ask.turn && item.status === "pending");
    if (option.kind === "reject" || option.kind === "reject-always") {
      setState(session, "running");
      if (tool) patch(session, tool.id, (item) => (item.k === "tool" ? { ...item, status: "failed", output: zh ? `已被 ${ME.name} 拒绝` : `Denied by ${ME.name}` } : item));
      streamAnswer(session, zh ? "好的，没有执行这条命令。需要的话告诉我换一种做法。" : "Understood, I did not run it. Tell me if you want a different approach.", 500, 2);
      return OK;
    }
    const done = zh ? "命令已执行完成，输出正常。\n\n- 远端已更新\n- 后续的流水线已经触发，我会留意它的结果" : "The command ran and its output looks right.\n\n- the remote is updated\n- the pipeline that follows has started; I'll keep an eye on it";
    if (tool && tool.k === "tool") runTool(session, tool.id, `$ ${tool.detail ?? ""}\nTo git.example:lantern-labs/sample.git\n * [new tag]         v0.9.0 -> v0.9.0`, done, 300);
    else {
      setState(session, "running");
      streamAnswer(session, done, 500, 3);
    }
    return OK;
  }

  async function archive(sessionId: string, archived: boolean): Promise<ActionResponse> {
    const session = known(sessionId);
    if (!session) return refuse(NO_SESSION);
    if (archived && busy(session)) return refuse("Stop the session before archiving it.");
    for (const entry of sessions.values()) if (entry === session || entry.row.parentId === sessionId) setRow(entry, { archived });
    return OK;
  }

  async function rename(sessionId: string, title: string): Promise<ActionResponse> {
    const session = known(sessionId);
    if (!session) return refuse(NO_SESSION);
    setRow(session, { title });
    return OK;
  }

  async function read(sessionId: string): Promise<ActionResponse> {
    const session = known(sessionId);
    if (!session) return refuse(NO_SESSION);
    if (session.row.unread) setRow(session, { unread: false });
    return OK;
  }

  async function mentions(query: MentionQuery): Promise<MentionRow[]> {
    if (phase !== "ready") return [];
    const rows: MentionRow[] = [...ROLES];
    const project = query.session ? sessions.get(query.session)?.row.project : undefined;
    for (const path of project ? (FILES[project] ?? []) : []) {
      const cut = path.lastIndexOf("/");
      rows.push({ kind: "file", id: path, label: path.slice(cut + 1), ...(cut > 0 ? { detail: path.slice(0, cut) } : {}) });
    }
    return rows;
  }

  async function createOptions(machineId?: string): Promise<CreateOptions> {
    if (phase !== "ready") return { machines: [], agents: [], projects: [] };
    const machines = MACHINES[workspaceId] ?? [];
    const here = new Set(machines.map((machine) => machine.id));
    const wanted = (id?: string) => (machineId ? !id || id === machineId : !id || here.has(id));
    return { machines, agents: AGENTS.filter((agent) => (machineId ? agent.machineId === machineId : here.has(agent.machineId))), projects: PROJECTS.filter((project) => wanted(project.machineId)) };
  }

  return {
    driver: "fixture",
    snapshot,
    transcript,
    older: async () => false,
    send,
    create,
    cancel,
    answer,
    archive,
    rename,
    read,
    mentions,
    options: createOptions,
    async workspace(id) {
      if (phase !== "ready") return refuse("Sign in before switching workspaces.");
      if (!WORKSPACES.some((workspace) => workspace.id === id)) return refuse("That workspace is not one you belong to.");
      if (workspaceId !== id) {
        workspaceId = id;
        changes.snapshot();
      }
      return OK;
    },
    async signin() {
      if (phase === "ready") return OK;
      if (phase === "signed-out") {
        phase = "signing-in";
        signinExpires = time + 10 * 60_000;
        changes.snapshot();
        after("", 4000, () => {
          phase = "ready";
          changes.snapshot();
          for (const id of sessions.keys()) changes.session(id);
        });
      }
      return OK;
    },
    async setup() {
      if (!setup) return refuse("This bridge has nothing to set up.");
      if (setup.state === "running") return OK;
      const stages = ["Downloading Node (4 of 30 MB)…", "Downloading Node (19 of 30 MB)…", "Unpacking Node…", "Installing the Lody CLI…", "Checking the Lody CLI…"];
      setup = { state: "running", step: "Starting…" };
      changes.snapshot();
      stages.forEach((step, index) =>
        after("", (index + 1) * 1000, () => {
          setup = { state: "running", step };
          changes.snapshot();
        }),
      );
      // set up, the device has the CLI and no account yet
      after("", (stages.length + 1) * 1000, () => {
        setup = undefined;
        phase = "signed-out";
        changes.snapshot();
        for (const id of sessions.keys()) changes.session(id);
      });
      return OK;
    },
    async signout() {
      if (phase === "signed-out") return OK;
      steps = steps.filter((step) => step.session !== "");
      phase = "signed-out";
      changes.snapshot();
      for (const id of sessions.keys()) changes.session(id);
      return OK;
    },
    subscribe: changes.subscribe,
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      steps = [];
      changes.clear();
    },
    advance,
    now: () => time,
  };
}
