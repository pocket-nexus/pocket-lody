// pocket-lody/service/cli-map.ts — the lody CLI's JSON as the applet's rows
// and items. Pure functions: cli.ts runs the commands, this file reads what
// they print. The shapes are the CLI's at 0.113.1 (`--json` of workspace
// list, session list, session history, machine list, session observe, and
// the files of `lody export`); every field is read defensively, because a
// newer CLI may drop or rename one.

import type { AskOption, Item, MachineRow, MentionRow, SendRequest, SessionRow, SessionState, ToolKind, ToolStatus, WorkspaceRow } from "../protocol.ts";

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);
const string = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Unix ms from the CLI's ISO strings and numbers. */
export function time(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// What a command printed.
// ---------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The JSON object in a command's stdout. Some commands print a log line
 *  before and after it ("[…] Remote Streams transport attached"), so the
 *  object is looked for between the first line that opens one and the last
 *  line that closes one. */
export function parseCliJson(stdout: string): Json | undefined {
  const text = stdout.replace(ANSI, "").trim();
  if (!text) return undefined;
  const direct = tryParse(text);
  if (direct) return direct;
  const lines = text.split("\n");
  const starts = lines.map((line, at) => (line.startsWith("{") ? at : -1)).filter((at) => at >= 0);
  const ends = lines.map((line, at) => (line.trimEnd().endsWith("}") ? at : -1)).filter((at) => at >= 0).reverse();
  for (const start of starts) {
    for (const end of ends) {
      if (end < start) break;
      const parsed = tryParse(lines.slice(start, end + 1).join("\n"));
      if (parsed) return parsed;
    }
  }
  return undefined;
}

function tryParse(text: string): Json | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** A CLI error as one line a person can read: no colour codes, no stack, not long. */
export function cleanError(message: string): string {
  const line = message.replace(ANSI, "").split("\n").map((part) => part.trim()).filter(Boolean)[0] ?? "";
  const text = line.replace(/^(CLI runtime error\s+)?((error|✖|×)[:\s]+)?/i, "");
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

export const isSignedOutError = (message: string) => /not logged in|lody login|unauthori[sz]ed|invalid (token|credentials)|401/i.test(message);

// ---------------------------------------------------------------------------
// Workspaces, machines, agents.
// ---------------------------------------------------------------------------

export interface CliWorkspace extends WorkspaceRow {
  slug?: string;
}

export function mapWorkspaces(json: Json | undefined): CliWorkspace[] {
  const out: CliWorkspace[] = [];
  for (const entry of list(json?.workspaces)) {
    const row = record(entry);
    const id = string(row?.id);
    if (!row || !id) continue;
    const slug = string(row.slug);
    const locked = row.contentMode === "e2ee" || row.encrypted === true;
    out.push({ id, name: string(row.name) ?? slug ?? id, ...(slug ? { slug } : {}), ...(locked ? { locked: true } : {}) });
  }
  return out;
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", "pi-acp": "Pi", pi: "Pi", grok: "Grok", kimi: "Kimi", gemini: "Gemini", cursor: "Cursor", devin: "Devin", deepseek: "DeepSeek" };

/** "claude" → "Claude"; an agent type nobody listed keeps its own spelling, capitalised. */
export function agentName(agentType: unknown): string | undefined {
  const type = string(agentType);
  if (!type) return undefined;
  return AGENT_NAMES[type.toLowerCase()] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

export interface CliAgent {
  id: string;
  name: string;
  machineId?: string;
  detail?: string;
}

export function mapMachines(json: Json | undefined, me: { userId?: string; machineId?: string }): { machines: MachineRow[]; agents: CliAgent[] } {
  const machines: MachineRow[] = [];
  const agents: CliAgent[] = [];
  for (const entry of list(json?.machines)) {
    const row = record(entry);
    const id = string(row?.id);
    if (!row || !id) continue;
    const online = row.online === true || row.onlineStatus === "online";
    const mine = (me.userId !== undefined && row.ownerUserId === me.userId) || id === me.machineId;
    machines.push({ id, name: string(row.name) ?? id, online, ...(mine ? { mine: true } : {}) });
    for (const config of list(row.agentConfigs)) {
      const agent = record(config);
      const agentId = string(agent?.id);
      if (!agent || !agentId) continue;
      const kind = agentName(agent.agentType);
      const name = string(agent.name) ?? kind ?? agentId;
      agents.push({ id: agentId, name, machineId: string(agent.machineId) ?? id, ...(kind && kind !== name ? { detail: kind } : {}) });
    }
  }
  machines.sort((a, b) => Number(b.online) - Number(a.online) || Number(b.mine ?? false) - Number(a.mine ?? false) || a.name.localeCompare(b.name));
  return { machines, agents };
}

export interface CliProject {
  id: string;
  name: string;
  kind: "github" | "local" | "chat";
  machineId?: string;
}

/** `project list --catalog --json`: a GitHub repository is `gh:<owner/repo>`, a local project `local:<id>`. */
export function mapProjects(json: Json | undefined): CliProject[] {
  const out = new Map<string, CliProject>();
  for (const entry of [...list(json?.projects), ...list(json?.items)]) {
    const row = record(entry);
    if (!row) continue;
    if (row.kind === "github") {
      const repo = string(row.repoFullName) ?? string(row.name);
      if (repo) out.set(`gh:${repo}`, { id: `gh:${repo}`, name: repo, kind: "github" });
    } else if (row.kind === "local") {
      const id = string(row.id) ?? string(row.localProjectId);
      const machineId = string(row.machineId);
      if (id) out.set(`local:${id}`, { id: `local:${id}`, name: string(row.name) ?? id, kind: "local", ...(machineId ? { machineId } : {}) });
    }
  }
  return [...out.values()];
}

/** The projects the sessions themselves name, for when the catalog has not been read. */
export function projectsOfSessions(metas: Iterable<Json>): CliProject[] {
  const seen = new Map<string, { project: CliProject; at: number }>();
  for (const meta of metas) {
    const project = record(meta.project);
    const at = number(meta.lastMessageAt) ?? time(meta.createdAt) ?? 0;
    let entry: CliProject | undefined;
    if (project?.kind === "github" || (!project && string(meta.repoFullName))) {
      const repo = string(project?.repoFullName) ?? string(meta.repoFullName);
      if (repo) entry = { id: `gh:${repo}`, name: repo, kind: "github" };
    } else if (project?.kind === "local") {
      const id = string(project.localProjectId);
      const machineId = string(meta.machineId);
      if (id) entry = { id: `local:${id}`, name: string(project.githubRepoFullName) ?? string(meta.repoFullName) ?? "Local project", kind: "local", ...(machineId ? { machineId } : {}) };
    }
    if (entry && (seen.get(entry.id)?.at ?? -1) < at) seen.set(entry.id, { project: entry, at });
  }
  return [...seen.values()].sort((a, b) => b.at - a.at).map((entry) => entry.project);
}

export function mapRoles(json: Json | undefined): MentionRow[] {
  const out: MentionRow[] = [];
  for (const entry of [...list(json?.roles), ...(list(json?.roles).length ? [] : list(json?.items))]) {
    const row = record(entry);
    const id = string(row?.id);
    if (!row || !id) continue;
    const detail = string(row.description);
    out.push({ kind: "role", id, label: `${string(row.emoji) ? `${row.emoji} ` : ""}${string(row.name) ?? id}`, ...(detail ? { detail: detail.slice(0, 80) } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// `session observe --jsonl`.
// ---------------------------------------------------------------------------

export interface ObservedTurn {
  userTurnId?: string;
  assistantTurnId?: string;
  state?: string;
  durationMs?: number;
}

export interface Observed {
  state: "idle" | "pending" | "running" | "waiting" | "unknown";
  /** "persisted": the session's history was read; "metadata": only its catalog row */
  source?: string;
  title?: string;
  archived?: boolean;
  latestTurn?: ObservedTurn;
  activeTurns: ObservedTurn[];
}

export type ObserveEvent =
  | { type: "snapshot" | "session.changed"; sessionId: string; session: Observed }
  | { type: "turn.started" | "turn.finished"; sessionId: string; userTurnId?: string; assistantTurnId?: string; outcome?: string; durationMs?: number }
  | { type: "session.removed"; sessionId: string }
  | { type: "ready" }
  | { type: "error"; error: string };

function mapTurn(value: unknown): ObservedTurn | undefined {
  const turn = record(value);
  if (!turn) return undefined;
  const userTurnId = string(turn.userTurnId);
  const assistantTurnId = string(turn.assistantTurnId);
  const state = string(turn.state);
  const durationMs = number(turn.durationMs);
  return { ...(userTurnId ? { userTurnId } : {}), ...(assistantTurnId ? { assistantTurnId } : {}), ...(state ? { state } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
}

export function mapObserved(value: unknown): Observed | undefined {
  const session = record(value);
  if (!session) return undefined;
  const state = string(session.state);
  const latestTurn = mapTurn(session.latestTurn);
  const title = string(session.title);
  const source = string(session.source);
  return {
    state: state === "idle" || state === "pending" || state === "running" || state === "waiting" ? state : "unknown",
    ...(source ? { source } : {}),
    ...(title ? { title } : {}),
    ...(typeof session.archived === "boolean" ? { archived: session.archived } : {}),
    ...(latestTurn ? { latestTurn } : {}),
    activeTurns: list(session.activeTurns).map(mapTurn).filter((turn): turn is ObservedTurn => turn !== undefined),
  };
}

/** One line of `session observe --jsonl --follow`; undefined for a line that is not an event. */
export function parseObserveLine(line: string): ObserveEvent | undefined {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  const event = tryParse(text);
  const type = string(event?.type);
  if (!event || !type) return undefined;
  if (type === "ready") return { type };
  if (type === "error") return { type, error: cleanError(string(event.error) ?? "the observation failed") };
  const sessionId = string(event.sessionId);
  if (!sessionId) return undefined;
  if (type === "session.removed") return { type, sessionId };
  if (type === "snapshot" || type === "session.changed") {
    const session = mapObserved(event.session);
    return session ? { type, sessionId, session } : undefined;
  }
  if (type === "turn.started" || type === "turn.finished") {
    const userTurnId = string(event.userTurnId);
    const assistantTurnId = string(event.assistantTurnId);
    const outcome = string(event.outcome);
    const durationMs = number(event.durationMs);
    return { type, sessionId, ...(userTurnId ? { userTurnId } : {}), ...(assistantTurnId ? { assistantTurnId } : {}), ...(outcome ? { outcome } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A session's row.
// ---------------------------------------------------------------------------

/** The latest turn the machine finished is the one marked failed (Lody's `hasFailedLatestTurn`). */
export const failedLatestTurn = (meta: Json) => typeof meta.lastFailedUserMsgId === "string" && meta.lastFailedUserMsgId.length > 0 && meta.lastFailedUserMsgId === meta.lastHandledUserMsgId;

/** How long "working" is believed with no activity. Lody draws its live
 *  status from presence, which the CLI does not expose: a machine that
 *  stopped mid-turn leaves "running" in the catalog and in the persisted
 *  turn for good. */
export const STALE_STATUS_MS = 12 * 60 * 60 * 1000;

/** What the row shows: the observation when it read the session's history,
 *  else the catalog's own status. A session in which nothing has happened
 *  for STALE_STATUS_MS (`now` given) is idle whatever either says. */
export function sessionState(meta: Json, observed?: Observed, now?: number): SessionState {
  const quietSince = number(meta.lastMessageAt) ?? time(meta.createdAt);
  // `observe` reads the persisted turn, which says "running" for good when its machine stopped mid-turn
  const stale = now !== undefined && quietSince !== undefined && now - quietSince > STALE_STATUS_MS;
  if (stale) return failedLatestTurn(meta) ? "failed" : "idle";
  if (observed && observed.state !== "unknown") {
    if (observed.state === "running") return "running";
    if (observed.state === "waiting") return "waiting";
    if (observed.state === "pending") return "starting";
    if (observed.latestTurn?.state === "failed") return "failed";
    return failedLatestTurn(meta) ? "failed" : "idle";
  }
  const status = string(record(meta.status)?.type);
  if (status === "requestPermission" || (number(meta.awaitingUserSince) !== undefined && status !== "idle")) return "waiting";
  if (status === "running") return "running";
  if (status === "initializing") return "starting";
  return failedLatestTurn(meta) ? "failed" : "idle";
}

function mapPrs(meta: Json): NonNullable<SessionRow["prs"]> {
  const out: NonNullable<SessionRow["prs"]> = [];
  for (const entry of list(meta.pullRequests)) {
    const pr = record(entry);
    const url = string(pr?.url);
    const status = string(pr?.status);
    if (!pr || !url) continue;
    const found = /\/pull\/(\d+)/.exec(url);
    out.push({ url, ...(found ? { number: Number(found[1]) } : {}), state: status === "merged" ? "merged" : status === "closed" ? "closed" : "open", ...(status === "draft" ? { draft: true } : {}) });
  }
  return out;
}

export interface RowContext {
  userId?: string;
  observed?: Observed;
  /** read marks kept on the bridge: the CLI cannot write Lody's own */
  readAt?: number;
  preview?: string;
  /** a local project's name, by id */
  projectName?: (localProjectId: string) => string | undefined;
  /** the time, for a catalog status too old to believe; default the clock's */
  now?: number;
}

export function mapSessionRow(meta: Json, context: RowContext = {}): SessionRow | undefined {
  const id = string(meta.id);
  if (!id) return undefined;
  const createdAt = time(meta.createdAt) ?? 0;
  const lastMessageAt = number(meta.lastMessageAt);
  const lastReadAt = Math.max(number(meta.lastReadAt) ?? -1, context.readAt ?? -1);
  const unread = lastMessageAt !== undefined && lastMessageAt > lastReadAt;
  const project = record(meta.project);
  const localId = project?.kind === "local" ? string(project.localProjectId) : undefined;
  const projectName = string(meta.repoFullName) ?? string(project?.repoFullName) ?? string(project?.githubRepoFullName) ?? (localId ? (context.projectName?.(localId) ?? "Local project") : undefined);
  const branch = string(meta.branchName) ?? string(project?.branch) ?? string(meta.baseBranch);
  const model = record(meta.lastModel);
  const modelName = string(model?.name) ?? string(model?.modelId);
  const prs = mapPrs(meta);
  const agent = agentName(meta.agentType);
  const machineId = string(meta.machineId);
  const parentId = string(meta.parentSessionId);
  const openedById = string(meta.openedBySessionId);
  const archived = meta.isArchived === true || context.observed?.archived === true;
  return {
    id,
    title: string(meta.title) ?? context.observed?.title ?? "Untitled",
    state: sessionState(meta, context.observed, context.now ?? Date.now()),
    createdAt,
    updatedAt: lastMessageAt ?? createdAt,
    ...(unread ? { unread: true } : {}),
    ...(context.userId !== undefined && meta.userId === context.userId ? { mine: true } : {}),
    ...(archived ? { archived: true } : {}),
    ...(meta.isPinned === true ? { pinned: true } : {}),
    ...(machineId ? { machineId } : {}),
    ...(agent ? { agent } : {}),
    ...(modelName ? { model: modelName } : {}),
    ...(projectName ? { project: projectName } : {}),
    ...(branch ? { branch } : {}),
    ...(parentId ? { parentId } : {}),
    ...(openedById && openedById !== parentId ? { openedById } : {}),
    ...(prs.length ? { prs } : {}),
    ...(context.preview ? { preview: context.preview } : {}),
  };
}

/** The rows a snapshot carries: every session that is not archived, and the
 *  most recent archived ones, newest first, at most `max`. A child stays with
 *  its parent. */
export function capRows(rows: SessionRow[], max = 240, archivedMax = 40): SessionRow[] {
  const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept: SessionRow[] = [];
  let archived = 0;
  for (const row of sorted) {
    if (row.archived && ++archived > archivedMax) continue;
    if (kept.length >= max) break;
    kept.push(row);
  }
  const ids = new Set(kept.map((row) => row.id));
  for (const row of [...kept]) {
    if (!row.parentId || ids.has(row.parentId)) continue;
    const parent = rows.find((entry) => entry.id === row.parentId);
    if (parent) {
      kept.push(parent);
      ids.add(parent.id);
    }
  }
  return kept;
}

export function oneLine(text: string, max = 110): string {
  const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>|]/g, "").replace(/\s+/g, " ").trim();
  const letters = Array.from(flat);
  return letters.length > max ? `${letters.slice(0, max - 1).join("")}…` : flat;
}

// ---------------------------------------------------------------------------
// `session history --json`: a user's messages and each turn's last visible text.
// ---------------------------------------------------------------------------

export interface HistoryContext {
  sessionId: string;
  userId?: string;
  userName?: string;
  /** the session's owner, for an entry without an author */
  ownerId?: string;
  state: SessionState;
  observed?: Observed;
  model?: string;
  /** a message was sent that this history does not hold yet: its last answer is of an earlier turn */
  awaiting?: boolean;
}

function completion(text: string): { tone: "info" | "error" | "done"; text: string } {
  const parsed = tryParse(text);
  const result = record(parsed?.completion);
  if (result?.type === "error") return { tone: "error", text: `A delegated task failed: ${cleanError(string(record(result.error)?.message) ?? "no reason given")}` };
  if (result?.type === "cancelled") return { tone: "info", text: "A delegated task was cancelled." };
  if (result?.type === "result") return { tone: "done", text: "A delegated task finished." };
  return { tone: "info", text: oneLine(text, 200) };
}

/** The items the CLI's history can give: no tool calls, thoughts or plans,
 *  and of a turn only its last visible text. The end of the latest turn, a
 *  failure and a wait for a person are added from the observation. */
export function mapHistory(json: Json | undefined, context: HistoryContext): Item[] {
  const items: Item[] = [];
  const busy = context.state === "running" || context.state === "starting" || context.state === "waiting";
  const entries = list(json?.entries).map(record).filter((entry): entry is Json => entry !== undefined && string(entry.id) !== undefined);
  entries.sort((a, b) => (number(a.index) ?? 0) - (number(b.index) ?? 0));
  let turn = "";
  let at = 0;
  let lastAssistant: string | undefined;
  entries.forEach((entry, position) => {
    const id = string(entry.id)!;
    at = time(entry.timestamp) ?? at;
    const text = typeof entry.text === "string" ? entry.text : "";
    if (entry.role === "user") {
      turn = id;
      const author = record(entry.author);
      const human = author?.kind === "human" || !author;
      const authorId = string(author?.userId) ?? (author ? undefined : context.ownerId);
      const mine = human && context.userId !== undefined && authorId === context.userId;
      const name = mine ? context.userName : author?.kind === "agent" ? string(author.name) : undefined;
      items.push({ k: "user", id, turn, at, text, ...(name ? { author: name } : {}), ...(mine ? { mine: true } : {}) });
    } else if (entry.role === "assistant") {
      lastAssistant = id;
      // the last answer is being written only when it answers the turn being
      // worked on: a history read before a new message landed ends with the
      // answer to the one before
      const working = context.observed?.activeTurns[0]?.userTurnId;
      const writing = busy && position === entries.length - 1 && (working ? working === turn : !context.awaiting);
      items.push({ k: "text", id, turn: turn || id, at, text, ...(writing ? { streaming: true } : { final: true }) });
    } else if (entry.role === "system") {
      items.push({ k: "notice", id, turn: turn || id, at, ...completion(text) });
    }
  });
  const latest = context.observed?.latestTurn;
  const tail = `${context.sessionId}:`;
  if (context.state === "waiting") {
    items.push({ k: "notice", id: `${tail}waiting`, turn, at, tone: "info", text: "The agent is waiting for a permission or an answer. Answer it in Lody on a phone or computer; this bridge cannot." });
  } else if (!busy && items.length > 0) {
    const outcome = context.state === "failed" ? "failed" : latest?.state === "completed" || latest?.state === "failed" || latest?.state === "canceled" ? latest.state : undefined;
    // the observation's latest turn is the one the last items belong to
    const matches = !latest?.userTurnId || latest.userTurnId === turn || (latest.assistantTurnId !== undefined && latest.assistantTurnId === lastAssistant);
    if (context.state === "failed") items.push({ k: "notice", id: `${tail}failed`, turn, at, tone: "error", text: "The last turn failed. Send a message to try again, or open Lody on a phone or computer for the reason." });
    if (outcome && matches) {
      const duration = latest?.durationMs !== undefined && latest.durationMs > 0 ? latest.durationMs : undefined;
      items.push({ k: "turn-end", id: `${latest?.assistantTurnId ?? lastAssistant ?? turn}:end`, turn, at, outcome, ...(duration !== undefined ? { durationMs: duration } : {}), ...(context.model ? { model: context.model } : {}) });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// `lody export`: a session's transcript.json, with every item.
// ---------------------------------------------------------------------------

const OUTPUT_TAIL = 2400;
const tail = (text: string, max = OUTPUT_TAIL) => (text.length > max ? `…${text.slice(text.length - max + 1)}` : text);

const TOOL_KINDS: Record<string, ToolKind> = { read: "read", edit: "edit", write: "edit", delete: "edit", move: "edit", search: "search", execute: "execute", bash: "execute", fetch: "fetch", think: "think" };
const TOOL_STATUS: Record<string, ToolStatus> = { pending: "pending", in_progress: "running", completed: "done", failed: "failed" };
const OPTION_KINDS: Record<string, AskOption["kind"]> = { allow_once: "allow", allow_always: "allow-always", reject_once: "reject", reject_always: "reject-always" };

function toolItem(item: Json, base: { id: string; turn: string; at: number }, live: boolean): Item[] {
  const name = string(item.toolName);
  const delegated = name === "Agent" || name === "Task" || /^mcp__lody__lody_session_(create|chat)/.test(name ?? "");
  const kind: ToolKind = delegated ? "delegate" : (TOOL_KINDS[string(item.kind) ?? ""] ?? "other");
  let status = TOOL_STATUS[string(item.status) ?? ""] ?? "done";
  // a call left open by a turn that has ended did not finish
  if (!live && (status === "pending" || status === "running")) status = "failed";
  let detail: string | undefined;
  let output = "";
  for (const entry of list(item.content)) {
    const block = record(entry);
    if (!block) continue;
    if (block.type === "terminal_command") detail = [string(block.command) ?? "", ...list(block.args).filter((arg): arg is string => typeof arg === "string")].join(" ").trim() || detail;
    else if (block.type === "terminal_output") output += typeof block.output === "string" ? block.output : "";
    else if (block.type === "content") {
      const inner = record(block.content);
      if (inner?.type === "text" && typeof inner.text === "string") output += `${output ? "\n" : ""}${inner.text}`;
    }
  }
  detail ??= string(record(list(item.locations)[0])?.path);
  const out: Item[] = [{ ...base, k: "tool", kind, title: oneLine(string(item.title) ?? name ?? "Tool call", 120), status, ...(detail ? { detail: tail(detail, 400) } : {}), ...(output.trim() ? { output: tail(output.trimEnd()) } : {}) }];
  const request = record(item.permissionRequest);
  const requestId = string(request?.requestId);
  if (request && requestId) {
    const options: AskOption[] = [];
    for (const entry of list(request.options)) {
      const option = record(entry);
      const id = string(option?.optionId);
      if (option && id) options.push({ id, label: string(option.name) ?? id, kind: name === "AskUserQuestion" ? "answer" : (OPTION_KINDS[string(option.kind) ?? ""] ?? "answer") });
    }
    const result = record(request.outcome);
    const chosen = result ? (result.outcome === "selected" ? (options.find((option) => option.id === result.optionId)?.label ?? "Answered") : "Cancelled") : live ? undefined : "Not answered";
    out.push({ id: `${base.id}:ask`, turn: base.turn, at: base.at, k: "ask", requestId, title: oneLine(string(item.title) ?? name ?? "Permission", 120), ...(detail ? { detail: tail(detail, 400) } : {}), options, ...(chosen ? { outcome: chosen } : {}), ...(name === "AskUserQuestion" ? { question: true } : {}) });
  }
  return out;
}

function noticeItem(item: Json, base: { id: string; turn: string; at: number }): Item {
  const meta = record(item.meta);
  const name = string(item.name);
  if (name === "chat_failed") return { ...base, k: "notice", tone: "error", text: `The turn failed: ${cleanError(string(meta?.message) ?? string(meta?.reason) ?? "no reason given")}` };
  if (name === "session_fork_origin") {
    const sessionId = string(meta?.sourceSessionId);
    return { ...base, k: "notice", tone: "info", text: `Forked from “${string(meta?.sourceTitle) ?? "another session"}”.`, ...(sessionId ? { sessionId } : {}) };
  }
  if (name === "agent_warning") return { ...base, k: "notice", tone: "info", text: cleanError(string(meta?.message) ?? "The agent reported a warning.") };
  return { ...base, k: "notice", tone: "info", text: string(item.text) ?? (name ?? "notice").replace(/_/g, " ") };
}

/** A transcript.json of `lody export` as items: text, thoughts, plans, tool
 *  calls with their commands and output, permission requests, notices and
 *  turn ends. The export leaves out a tool call's diff blocks, so no item
 *  has a `diff`. `busy` says the last turn may still be going. */
export function mapExportTranscript(json: Json | undefined, context: { userId?: string; userName?: string; ownerId?: string; busy?: boolean } = {}): Item[] {
  const items: Item[] = [];
  const turns = list(json?.turns).map(record).filter((turn): turn is Json => turn !== undefined && string(turn.turnId) !== undefined);
  let userTurn = "";
  turns.forEach((entry, position) => {
    const turnId = string(entry.turnId)!;
    const at = time(entry.timestamp) ?? 0;
    const parts = list(entry.items).map(record).filter((part): part is Json => part !== undefined);
    const live = context.busy === true && position === turns.length - 1;
    if (entry.role === "user") {
      userTurn = turnId;
      const text = parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n\n").trim();
      const attachments = parts.reduce((count, part) => count + (part.type === "image" || part.type === "file" || part.type === "local_attachment" ? 1 : part.type === "image_group" ? list(part.images).length : 0), 0);
      const author = record(entry.author);
      const authorId = string(author?.userId) ?? (author ? undefined : context.ownerId);
      const mine = (!author || author.kind === "human") && context.userId !== undefined && authorId === context.userId;
      const name = mine ? context.userName : author?.kind === "agent" ? string(author.name) : undefined;
      if (text || attachments) items.push({ k: "user", id: turnId, turn: turnId, at, text, ...(name ? { author: name } : {}), ...(mine ? { mine: true } : {}), ...(entry.sendStatus === "failed" ? { delivery: "failed" as const } : {}), ...(attachments ? { attachments } : {}) });
      return;
    }
    const turn = userTurn || turnId;
    let failed = false;
    let lastText = -1;
    const started = items.length;
    parts.forEach((part, index) => {
      const base = { id: `${turnId}:${index}`, turn, at };
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        lastText = items.length;
        items.push({ ...base, k: "text", text: part.text, ...(part.messagePhase === "final_answer" ? { final: true } : {}) });
      } else if (part.type === "thought" && typeof part.text === "string" && part.text.trim()) items.push({ ...base, k: "thought", text: part.text });
      else if (part.type === "plan") {
        const entries = list(part.entries).map(record).filter((step): step is Json => step !== undefined && typeof step.content === "string").map((step) => ({ text: step.content as string, status: step.status === "completed" ? ("done" as const) : step.status === "in_progress" ? ("running" as const) : ("pending" as const) }));
        if (entries.length) items.push({ ...base, k: "plan", entries });
      } else if (part.type === "proposed_plan" && typeof part.markdown === "string" && part.status !== "cleared") items.push({ ...base, k: "text", text: part.markdown });
      else if (part.type === "tool_call") items.push(...toolItem(part, base, live));
      else if (part.type === "subagent_task") items.push({ ...base, k: "tool", kind: "delegate", title: oneLine(string(part.description) ?? string(part.summary) ?? "Subagent task", 120), status: part.status === "completed" ? "done" : part.status === "failed" ? "failed" : live ? "running" : "failed", ...(string(part.summary) && string(part.description) ? { output: tail(part.summary as string) } : {}) });
      else if (part.type === "system_notice") {
        failed ||= part.name === "chat_failed";
        items.push(noticeItem(part, base));
      } else if (part.type === "operation_completion") items.push({ ...base, k: "notice", ...completion(JSON.stringify(part)) });
      else if (part.type === "operation_completion_batch") items.push({ ...base, k: "notice", tone: "done", text: `${number(part.memberCount) ?? "Some"} delegated tasks finished.` });
    });
    if (entry.role !== "assistant") return;
    const last = lastText >= started ? items[lastText] : undefined;
    if (last?.k === "text") {
      if (live) items[lastText] = { ...last, streaming: true };
      else if (!last.final) items[lastText] = { ...last, final: true };
    }
    const ended = entry.finished === true || number(entry.endedAt) !== undefined;
    if (!live && (ended || position < turns.length - 1)) {
      const startedAt = number(entry.startedAt);
      const endedAt = number(entry.endedAt);
      const model = string(record(entry.modelInfo)?.name) ?? string(record(entry.modelInfo)?.modelId);
      items.push({ id: `${turnId}:end`, turn, at: endedAt ?? at, k: "turn-end", outcome: failed ? "failed" : "completed", ...(startedAt !== undefined && endedAt !== undefined && endedAt > startedAt ? { durationMs: endedAt - startedAt } : {}), ...(model ? { model } : {}) });
    }
  });
  return items;
}

// ---------------------------------------------------------------------------
// What is sent.
// ---------------------------------------------------------------------------

/** A message with its @ tokens written the way Lody reads them: a session
 *  as `[@Title](lody://session/<id>?workspace=<id>)`, a role as
 *  `[Agent Role: <name> (agentRoleId: <id>)]`; a file's path stays as typed. */
export function mentionText(text: string, mentions: SendRequest["mentions"], lookup: { workspaceId?: string; sessionTitle(id: string): string | undefined; roleName(id: string): string | undefined }): string {
  let out = text;
  for (const mention of [...(mentions ?? [])].sort((a, b) => b.start - a.start)) {
    if (mention.start < 0 || mention.end > out.length || mention.end <= mention.start) continue;
    let token: string | undefined;
    if (mention.kind === "session") {
      const title = (lookup.sessionTitle(mention.id) ?? "session").replace(/[[\]]/g, "");
      token = `[@${title}](lody://session/${mention.id}${lookup.workspaceId ? `?workspace=${lookup.workspaceId}` : ""})`;
    } else if (mention.kind === "role") {
      token = `[Agent Role: ${(lookup.roleName(mention.id) ?? "role").replace(/[[\]]/g, "")} (agentRoleId: ${mention.id})]`;
    }
    if (token) out = `${out.slice(0, mention.start)}${token}${out.slice(mention.end)}`;
  }
  return out;
}

/** The page and the code `lody login` prints for a device sign-in. */
export function parseLoginOutput(text: string): { url: string; code?: string; expiresAt?: number } | undefined {
  const plain = text.replace(ANSI, "");
  // with --debug the CLI names its servers first: the page is the address
  // that carries the code, else the one it asks the reader to visit
  const urls = [...plain.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0].replace(/[.,)]+$/, ""));
  const visit = /visit:?\s*(https?:\/\/[^\s"'<>]+)/i.exec(plain)?.[1]?.replace(/[.,)]+$/, "");
  const url = urls.find((candidate) => /[?&]user_code=/.test(candidate)) ?? visit;
  if (!url) return undefined;
  let code: string | undefined;
  try {
    code = new URL(url).searchParams.get("user_code") ?? undefined;
  } catch {
    return undefined;
  }
  // `login --debug` says when the code expires: "... expires_in=1800s deadline=2026-01-01T00:30:00.000Z"
  const deadline = /\bdeadline=(\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(plain);
  const expiresAt = deadline ? Date.parse(deadline[1]!) : NaN;
  return { url, ...(code ? { code } : {}), ...(Number.isFinite(expiresAt) ? { expiresAt } : {}) };
}

/** Why a `lody login` ended without a sign-in, as a sentence; undefined when its output does not say. */
export function loginFailure(text: string): string | undefined {
  const plain = text.replace(ANSI, "");
  if (/code expired|expired_token/i.test(plain)) return "The sign-in code expired before it was confirmed. Start the sign-in again for a new one.";
  if (/denied/i.test(plain)) return "The sign-in was refused on the page. Start it again to try with another account.";
  if (/network error|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|Failed to request device code/i.test(plain)) return "Lody could not be reached to sign in. Check the network and start the sign-in again.";
  return undefined;
}

/** A Node version the lody CLI runs on (its package's `engines`). */
export function nodeRunsLody(version: string): boolean {
  const found = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!found) return false;
  const [major, minor, patch] = [Number(found[1]), Number(found[2]), Number(found[3])];
  const atLeast = (m: number, p: number) => minor > m || (minor === m && patch >= p);
  if (major === 22) return atLeast(23, 4);
  if (major === 24) return atLeast(22, 1);
  if (major === 26) return atLeast(12, 1);
  return false;
}
