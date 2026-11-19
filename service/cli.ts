// pocket-lody/service/cli.ts — a driver over the `lody` CLI (the npm package
// `lody`), run as a subprocess on the computer that is signed in to Lody.
//
// Every CLI command starts cold and syncs before it answers: seconds each.
// So the driver answers from what it holds and refreshes behind:
//  - ONE long-lived `session observe --all --jsonl --follow` says when a
//    session's state changes or a turn starts or ends. It is restarted with
//    a backoff when it exits.
//  - `session list --all` is read at the start, after an observed change
//    (not more often than every 15 s) and every two minutes as a net.
//  - `session history <id>` is read when a session is opened, when a
//    change is observed in a session someone has open, and every few
//    seconds while it is open and working. A session that changes while
//    nobody has it open is only marked, and read at its next opening. The
//    six most recent sessions are read ahead at the start.
//  - At most two commands run at once besides the observation, and of
//    refreshes only one: what a person asked for does not queue behind them.
//
// What the CLI cannot do is refused with a sentence that says where to do
// it: answering a permission or a question, steering a running turn. A read
// mark is kept on the bridge, because the CLI cannot write Lody's.
//
// The credentials file is read for the account's name and this computer's
// name only; the token in it is never read into a variable, logged or sent.
// A child's output is never logged either: a log line names the command, its
// exit code and how long it took.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResponse, CreateOptions, Item, Link, MachineRow, MentionRow, SessionRow } from "../protocol.ts";
import { Changes, OK, refuse, type BackendCreate, type BackendSend, type BackendSnapshot, type BackendTranscript, type LodyBackend, type MentionQuery } from "./backend.ts";
import { qrRows } from "./qr.ts";
import { capRows, cleanError, isSignedOutError, mapExportTranscript, mapHistory, mapMachines, mapProjects, mapRoles, mapSessionRow, loginFailure, mapWorkspaces, mentionText, oneLine, parseCliJson, parseLoginOutput, parseObserveLine, projectsOfSessions, sessionState, type CliAgent, type CliProject, type CliWorkspace, type Observed, type ObserveEvent } from "./cli-map.ts";

type Json = Record<string, unknown>;

export interface CliConfig {
  /** the Node that runs the CLI (the CLI needs 22.23.4+, 24.22.1+ or 26.12.1+) */
  node: string;
  /** the CLI's entry script, or the arguments that come after `node` */
  cli: string[] | string;
  /** where the CLI keeps its sign-in (LODY_DATA_DIR); default ~/.lody */
  dataDir?: string;
  /** the workspace to open first: an id, a slug or a name */
  workspace?: string;
  /** the name a sign-in made here registers this device under (`lody login
   *  --machine-name`); default: the CLI's own, the hostname */
  machineName?: string;
  /** where the driver keeps the workspace it was left on and its read marks */
  cacheDir?: string;
  /** "export": fill opened sessions with every item from a whole-workspace
   *  `lody export --offline`. Off by default: the export cannot name one
   *  session, so it costs the whole workspace each time. */
  richTranscripts?: "export";
  /** the most sessions a snapshot carries, newest first; default 150 */
  sessionLimit?: number;
  /** let /signout run `lody logout` even though the sign-in is the computer's own */
  allowSignOut?: boolean;
  log?: (line: string) => void;
  /** intervals, for tests */
  timing?: Partial<typeof TIMING>;
}

export const TIMING = {
  /** the driver's clock */
  tickMs: 1000,
  /** after an observed change, the list is read this much later */
  listDebounceMs: 800,
  /** and not sooner than this after the last read */
  listMinGapMs: 15_000,
  listEveryMs: 120_000,
  /** while the observation is down */
  listEveryDownMs: 30_000,
  machinesEveryMs: 120_000,
  /** an open, working session's history is read again this long after the last read ended */
  openRefreshMs: 1500,
  /** a turn that ended is shown at work at most this long while its answer is read */
  catchUpMs: 45_000,
  /** a session this driver started is listed this long before the CLI's list has it */
  provisionalMs: 120_000,
  /** a session counts as open this long after it was last asked for */
  openFreshMs: 45_000,
  forgetMs: 30 * 60_000,
  observeBackoffMs: 1000,
  observeBackoffMaxMs: 30_000,
  /** the first snapshot waits this long for the workspace to load */
  bootWaitMs: 8000,
  retryBootMs: 30_000,
  rolesTtlMs: 10 * 60_000,
  projectsTtlMs: 30 * 60_000,
  exportEveryMs: 10 * 60_000,
  commandMs: 90_000,
};

/** a snapshot is sent whole at every change: this many rows is about 50 KiB */
const SESSIONS_MAX = 150;
const ARCHIVED_MAX = 20;
const HISTORY_FIRST = 60;
const HISTORY_MAX = 4000;
const PREFETCH = 6;
const EXPORT_FILE_MAX = 24 * 1024 * 1024;
/** what a session the bridge acts for must not inherit from the process that started it */
const SCRUBBED_ENV = ["LODY_SESSION_ID", "LODY_AGENT_SESSION_ID", "LODY_WORKSPACE_SESSION_ID", "LODY_WORKSPACE_ID", "LODY_AGENT_CONFIG_ID"];

class CliError extends Error {}

type Priority = 0 | 1 | 2;

interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  /** 0: a person is waiting; 1: a session that is open; 2: behind */
  priority?: Priority;
  env?: Record<string, string>;
}

/** Runs CLI commands, two at a time. */
function createRunner(config: CliConfig, log: (line: string) => void, commandMs: number) {
  const prefix = typeof config.cli === "string" ? [config.cli] : config.cli;
  const children = new Set<ChildProcess>();
  const waiting: { priority: Priority; go: () => void }[] = [];
  let active = 0;
  let behind = 0;
  let closed = false;

  function environment(extra?: Record<string, string>): NodeJS.ProcessEnv {
    // Node tries a host's addresses in turn and gives each 250 ms to connect.
    // On a handheld's Wi-Fi, under proot, a connection that is going to
    // succeed can take longer, and the command then ends in "fetch failed"
    // within a second. Each address gets five seconds here.
    const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --network-family-autoselection-attempt-timeout=5000`.trim();
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", NODE_OPTIONS: nodeOptions, ...(config.dataDir ? { LODY_DATA_DIR: config.dataDir } : {}), ...extra };
    for (const name of SCRUBBED_ENV) delete env[name];
    return env;
  }

  /** A command's name for a log line: never an id, a title or a path. */
  const label = (args: string[]) => `${args[0] ?? ""}${args[1] && /^[a-z][a-z-]*$/.test(args[1]) ? ` ${args[1]}` : ""}`;

  // Two at once, and of the work nobody is waiting for only one: what a
  // person asked for does not queue behind refreshes.
  const admits = (priority: Priority) => active < 2 && (priority === 0 || behind < 1);
  const admit = (priority: Priority) => {
    active++;
    if (priority > 0) behind++;
  };

  function slot(priority: Priority): Promise<void> {
    if (admits(priority)) {
      admit(priority);
      return Promise.resolve();
    }
    return new Promise((go) => {
      const at = waiting.findIndex((entry) => entry.priority > priority);
      waiting.splice(at < 0 ? waiting.length : at, 0, { priority, go });
    });
  }

  function release(priority: Priority) {
    active--;
    if (priority > 0) behind--;
    const at = waiting.findIndex((entry) => admits(entry.priority));
    if (at < 0) return;
    const [next] = waiting.splice(at, 1);
    admit(next!.priority);
    next!.go();
  }

  async function run(args: string[], options: RunOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const priority = options.priority ?? 2;
    await slot(priority);
    if (closed) {
      release(priority);
      throw new CliError("the bridge is shutting down");
    }
    const started = Date.now();
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(config.node, [...prefix, ...args], { env: environment(options.env), stdio: ["pipe", "pipe", "pipe"] });
        children.add(child);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timeout = options.timeoutMs ?? commandMs;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout);
        child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-8192)));
        child.on("error", (error) => {
          clearTimeout(timer);
          children.delete(child);
          reject(new CliError(`the lody CLI could not be started (${(error as NodeJS.ErrnoException).code ?? error.message})`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          children.delete(child);
          log(`lody ${label(args)}: exit ${code ?? "killed"} in ${Date.now() - started} ms`);
          if (timedOut) reject(new CliError(`the lody CLI took more than ${Math.round(timeout / 1000)} s to answer`));
          else resolve({ code: code ?? 1, stdout, stderr });
        });
        child.stdin!.on("error", () => {});
        child.stdin!.end(options.stdin ?? "");
      });
    } finally {
      release(priority);
    }
  }

  /** A command's JSON; a failure is thrown as its own sentence. */
  async function json(args: string[], options: RunOptions = {}): Promise<Json> {
    const result = await run(args, options);
    const parsed = parseCliJson(result.stdout);
    if (parsed && parsed.ok !== false && result.code === 0) return parsed;
    const said = typeof parsed?.error === "string" ? parsed.error : result.stderr.trim() || result.stdout.trim();
    throw new CliError(cleanError(said) || `the lody CLI exited with code ${result.code}`);
  }

  /** A child that stays: the observation, a sign-in. Not counted against the two. */
  function long(args: string[], env?: Record<string, string>): ChildProcess {
    const child = spawn(config.node, [...prefix, ...args], { env: environment(env), stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.on("error", () => children.delete(child));
    return child;
  }

  return {
    run,
    json,
    long,
    close() {
      closed = true;
      for (const child of children) child.kill("SIGTERM");
      for (const entry of waiting.splice(0)) {
        admit(entry.priority);
        entry.go();
      }
    },
  };
}

interface History {
  json?: Json;
  limit: number;
  fetchedAt: number;
  /** when the read that brought `json` started: what happened after is not in it */
  startedAt?: number;
  touchedAt: number;
  loading?: Promise<void>;
  again?: boolean;
  /** every item of the turns an export held, and those turns' ids */
  rich?: { items: Item[]; turns: Set<string>; total: number };
}

interface LocalSend {
  item: Extract<Item, { k: "user" }>;
  userTurnId?: string;
  error?: string;
}

export function createCliBackend(config: CliConfig): LodyBackend {
  const timing = { ...TIMING, ...config.timing };
  const log = config.log ?? (() => {});
  const changes = new Changes();
  const cli = createRunner(config, log, timing.commandMs);
  const dataDir = config.dataDir ?? process.env.LODY_DATA_DIR ?? join(homedir(), ".lody");
  const cacheDir = config.cacheDir ?? join(tmpdir(), "pocket-lody-cli");
  const statePath = join(cacheDir, "state.json");
  /** the sign-in is the bridge's own to end */
  const ownAccount = Boolean(config.dataDir || config.allowSignOut);
  let closed = false;

  // --- what the driver holds ---------------------------------------------------
  let phase: Link["phase"] = "ready";
  let detail: string | undefined;
  let signin: { url?: string; code?: string; qr?: string[]; expiresAt?: number; child?: ChildProcess } | undefined;
  let me: { id?: string; name?: string; email?: string; machineId?: string; machineName?: string } = {};
  let workspaces: CliWorkspace[] = [];
  let workspaceId: string | undefined;
  const metas = new Map<string, Json>();
  let listLoaded = false;
  let listAt = 0;
  const observed = new Map<string, Observed>();
  /** when the observation last said a session's turn ended: its answer is in a history read after that */
  const endedAt = new Map<string, number>();
  let machines: MachineRow[] = [];
  let agents: CliAgent[] = [];
  let machinesAt = 0;
  let projects: { rows: CliProject[]; at: number; loading?: boolean } = { rows: [], at: 0 };
  let roles: { rows: MentionRow[]; at: number; loading?: Promise<void> } = { rows: [], at: 0 };
  const histories = new Map<string, History>();
  const locals = new Map<string, LocalSend[]>();
  let localIds = 0;
  /** `workspaceId`: the one a person switched to; `picked`: the one the driver chose for want of that */
  let saved: { workspaceId?: string; picked?: string; readAt: Record<string, number> } = { readAt: {} };
  /** what an action changed, kept over a list that was read before the change landed */
  const patches = new Map<string, { fields: Json; at: number }>();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { workspaceId?: unknown; picked?: unknown; readAt?: unknown };
    saved = { ...(typeof parsed.workspaceId === "string" ? { workspaceId: parsed.workspaceId } : {}), ...(typeof parsed.picked === "string" ? { picked: parsed.picked } : {}), readAt: parsed.readAt && typeof parsed.readAt === "object" ? (parsed.readAt as Record<string, number>) : {} };
  } catch {
    // nothing saved yet
  }

  function save() {
    try {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      if (listLoaded) for (const id of Object.keys(saved.readAt)) if (!metas.has(id)) delete saved.readAt[id];
      writeFileSync(statePath, JSON.stringify(saved), { mode: 0o600 });
    } catch {
      // a read mark that is not saved is asked for again
    }
  }

  /** The account's name and this computer's, from the CLI's credentials file. Never the token. */
  function readAccount(): boolean {
    try {
      const file = JSON.parse(readFileSync(join(dataDir, "credentials.json"), "utf8")) as { user?: { id?: unknown; name?: unknown; email?: unknown }; machine?: { machineId?: unknown; machineName?: unknown } };
      const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
      me = { id: text(file.user?.id), name: text(file.user?.name), email: text(file.user?.email), machineId: text(file.machine?.machineId), machineName: text(file.machine?.machineName) };
      return true;
    } catch {
      me = {};
      return false;
    }
  }

  const link = (): Link => ({
    phase,
    driver: "cli",
    via: me.machineName ?? config.machineName ?? hostname(),
    ...(phase === "ready" && (me.name || me.email) ? { user: { name: me.name ?? me.email!, ...(me.email ? { email: me.email } : {}) } } : {}),
    ...(signin?.url ? { url: signin.url } : {}),
    ...(signin?.code ? { code: signin.code } : {}),
    ...(signin?.qr ? { qr: signin.qr } : {}),
    ...(signin?.expiresAt ? { expiresAt: signin.expiresAt } : {}),
    ...(phase !== "ready" && config.machineName ? { machine: config.machineName } : {}),
    ...(ownAccount ? { ownAccount: true } : {}),
    ...(detail ? { detail } : {}),
  });

  // --- starting ------------------------------------------------------------------
  let bootAt = 0;
  let booting: Promise<void> | undefined;

  function boot(): Promise<void> {
    if (booting) return booting;
    bootAt = Date.now();
    const run: Promise<void> = start().catch((error: unknown) => unavailable(`The bridge's driver could not start: ${(error as Error).message}`));
    booting = run;
    // `start` may finish without waiting for anything: `booting` is cleared after it is set
    void run.then(() => {
      if (booting === run) booting = undefined;
    });
    return run;
  }

  async function start(): Promise<void> {
    if (!existsSync(config.node)) return unavailable(`Node is not at ${config.node}; set "node" in the bridge's config to a Node the lody CLI runs on.`);
    const script = typeof config.cli === "string" ? config.cli : config.cli[0];
    if (script && script.startsWith("/") && !existsSync(script)) return unavailable(`The lody CLI is not at ${script}; install it (npm install lody) and set "cli" in the bridge's config.`);
    if (!readAccount()) return signedOut();
    let found: CliWorkspace[];
    try {
      found = mapWorkspaces(await cli.json(["workspace", "list", "--json"], { priority: 0 }));
    } catch (error) {
      const reason = (error as Error).message;
      return isSignedOutError(reason) ? signedOut() : unavailable(`The lody CLI could not list your workspaces: ${reason}`);
    }
    workspaces = found;
    phase = "ready";
    detail = undefined;
    signin = undefined;
    workspaceId = await pickWorkspace();
    changes.snapshot();
    if (workspaceId) await openWorkspace();
  }

  function unavailable(why: string) {
    phase = "unavailable";
    detail = why;
    log(`lody bridge unavailable: ${why}`);
    changes.snapshot();
  }

  /** The credentials file's time of change, 0 without one. */
  function accountStamp(): number {
    try {
      return statSync(join(dataDir, "credentials.json")).mtimeMs;
    } catch {
      return 0;
    }
  }
  let signedOutStamp = 0;

  function signedOut(why = ownAccount && config.machineName ? `${config.machineName} is not signed in to Lody. Sign in to see your sessions.` : "This bridge is not signed in to Lody. Sign in here, or run `lody login` on the computer.") {
    signedOutStamp = accountStamp();
    phase = "signed-out";
    detail = why;
    workspaces = [];
    workspaceId = undefined;
    stopObserve();
    metas.clear();
    histories.clear();
    listLoaded = false;
    changes.snapshot();
  }

  /** A session list read while picking the workspace, so it is not read twice. */
  let seed: { workspace: string; json: Json } | undefined;

  async function pickWorkspace(): Promise<string | undefined> {
    const named = config.workspace?.toLowerCase();
    const wanted = named ? workspaces.find((row) => row.id === config.workspace || row.slug?.toLowerCase() === named || row.name.toLowerCase() === named) : undefined;
    const open = workspaces.filter((row) => !row.locked);
    if (saved.workspaceId && workspaces.some((row) => row.id === saved.workspaceId)) return saved.workspaceId;
    if (wanted) return wanted.id;
    if (open.length <= 1) return (open[0] ?? workspaces[0])?.id;
    if (saved.picked && open.some((row) => row.id === saved.picked)) return saved.picked;
    // the workspace someone worked in last
    let best: { id: string; at: number } | undefined;
    await Promise.all(
      open.slice(0, 6).map(async (row) => {
        try {
          const json = await cli.json(["session", "list", "--workspace", row.id, "--all", "--json"], { priority: 0 });
          const at = (Array.isArray(json.sessions) ? (json.sessions as Json[]) : []).reduce((latest, meta) => (typeof meta.lastMessageAt === "number" && meta.lastMessageAt > latest ? meta.lastMessageAt : latest), 0);
          if (!best || at > best.at) {
            best = { id: row.id, at };
            seed = { workspace: row.id, json };
          }
        } catch {
          // a workspace that cannot be listed is not the default
        }
      }),
    );
    saved.picked = best?.id ?? open[0]!.id;
    save();
    return saved.picked;
  }

  async function openWorkspace() {
    metas.clear();
    observed.clear();
    endedAt.clear();
    histories.clear();
    locals.clear();
    listLoaded = false;
    projects = { rows: [], at: 0 };
    roles = { rows: [], at: 0 };
    startObserve();
    const read = seed && seed.workspace === workspaceId ? seed.json : undefined;
    seed = undefined;
    if (read) applyList(read);
    await Promise.all([read ? Promise.resolve() : refreshList(), refreshMachines()]);
    // the sessions someone is most likely to open are read ahead
    const recent = [...metas.values()].filter((meta) => meta.isArchived !== true).sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0));
    for (const meta of recent.slice(0, PREFETCH)) void fetchHistory(meta.id as string, 2).catch(() => {});
  }

  // --- the observation -------------------------------------------------------------
  let observe: { child: ChildProcess; ready: boolean } | undefined;
  let observeBackoff = timing.observeBackoffMs;
  let observeTimer: ReturnType<typeof setTimeout> | undefined;

  function stopObserve() {
    if (observeTimer) clearTimeout(observeTimer);
    observeTimer = undefined;
    const old = observe;
    observe = undefined;
    old?.child.kill("SIGTERM");
  }

  function startObserve() {
    stopObserve();
    const workspace = workspaceId;
    if (!workspace || closed || phase !== "ready") return;
    const child = cli.long(["session", "observe", "--workspace", workspace, "--all", "--jsonl", "--follow"]);
    const mine = { child, ready: false };
    observe = mine;
    let buffer = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const event = parseObserveLine(line);
        if (event && observe === mine) onObserved(event, mine);
      }
      if (buffer.length > 4 * 1024 * 1024) buffer = "";
    });
    child.stderr!.resume();
    const ended = () => {
      if (observe !== mine) return;
      observe = undefined;
      if (closed) return;
      log(`lody session observe ended; starting it again in ${observeBackoff} ms`);
      observeTimer = setTimeout(startObserve, observeBackoff);
      observeBackoff = Math.min(timing.observeBackoffMaxMs, observeBackoff * 2);
    };
    child.on("close", ended);
    child.on("error", ended);
  }

  function onObserved(event: ObserveEvent, source: { ready: boolean }) {
    if (event.type === "ready") {
      source.ready = true;
      observeBackoff = timing.observeBackoffMs;
      changes.snapshot();
      return;
    }
    if (event.type === "error") {
      log(`lody session observe: ${event.error}`);
      return;
    }
    const id = event.sessionId;
    if (event.type === "session.removed") {
      observed.delete(id);
      endedAt.delete(id);
      metas.delete(id);
      histories.delete(id);
      changes.snapshot();
      changes.session(id);
      return;
    }
    if (event.type === "snapshot" || event.type === "session.changed") {
      const was = observed.get(id);
      const before = JSON.stringify(was);
      observed.set(id, event.session);
      if (before === JSON.stringify(event.session)) return;
      const working = (state: Observed["state"] | undefined) => state === "running" || state === "pending" || state === "waiting";
      if (source.ready && working(was?.state) && !working(event.session.state)) endedAt.set(id, Date.now());
      changes.snapshot();
      changes.session(id);
    }
    // the catalog's first pass is not news
    if (!source.ready) return;
    scheduleList(!metas.has(id));
    refreshOrStale(id);
  }

  // --- the list, the machines -------------------------------------------------------
  let listRunning: Promise<void> | undefined;
  let listAgain = false;
  let listTimer: ReturnType<typeof setTimeout> | undefined;

  /** Reads the list soon. An observed change waits out the gap since the
   *  last read, because sessions at work change all the time and each read
   *  is a process; `now` is for what a person just did. */
  function scheduleList(now = false) {
    if (closed) return;
    const delay = now ? 0 : Math.max(timing.listDebounceMs, listAt + timing.listMinGapMs - Date.now());
    if (listTimer) {
      if (!now) return;
      clearTimeout(listTimer);
    }
    listTimer = setTimeout(() => {
      listTimer = undefined;
      void refreshList();
    }, delay);
  }

  const signature = (meta: Json | undefined) => JSON.stringify([meta?.lastMessageAt, meta?.latestUserMsgId, meta?.lastHandledUserMsgId, meta?.processingUserMsgId, meta?.status]);

  function refreshList(): Promise<void> {
    if (listRunning) {
      listAgain = true;
      return listRunning;
    }
    const workspace = workspaceId;
    if (!workspace || phase !== "ready") return Promise.resolve();
    listRunning = (async () => {
      try {
        // the first list is what a person is waiting for
        const json = await cli.json(["session", "list", "--workspace", workspace, "--all", "--json"], { priority: listLoaded ? 1 : 0 });
        if (workspace === workspaceId) applyList(json);
      } catch (error) {
        const reason = (error as Error).message;
        log(`lody session list failed: ${reason}`);
        if (isSignedOutError(reason)) signedOut();
        listAt = Date.now();
      } finally {
        listRunning = undefined;
        if (listAgain && !closed) {
          listAgain = false;
          scheduleList();
        }
      }
    })();
    return listRunning;
  }

  /** Takes a `session list --all` as the workspace's sessions. */
  function applyList(json: Json) {
    const fresh = new Map<string, Json>();
    for (const entry of Array.isArray(json.sessions) ? (json.sessions as Json[]) : []) if (entry && typeof entry.id === "string") fresh.set(entry.id, entry);
    for (const [id, patch] of patches) {
      const entry = fresh.get(id);
      const landed = entry !== undefined && Object.entries(patch.fields).every(([name, value]) => (entry[name] ?? false) === value);
      if (!entry || landed || Date.now() - patch.at > 30_000) patches.delete(id);
      else Object.assign(entry, patch.fields);
    }
    // a session this driver just started is kept until the list has it
    for (const [id, meta] of metas) if (meta.provisional === true && !fresh.has(id) && Date.now() - Number(meta.lastMessageAt) < timing.provisionalMs) fresh.set(id, meta);
    const moved = [...histories.keys()].filter((id) => signature(metas.get(id)) !== signature(fresh.get(id)));
    metas.clear();
    for (const [id, meta] of fresh) metas.set(id, meta);
    listLoaded = true;
    listAt = Date.now();
    changes.snapshot();
    for (const id of moved) {
      if (!fresh.has(id)) {
        histories.delete(id);
        changes.session(id);
      } else refreshOrStale(id);
    }
  }

  /** A session changed: its history is read again now if someone has it
   *  open, and at its next opening otherwise. */
  function refreshOrStale(id: string) {
    const history = histories.get(id);
    if (!history) return;
    if (Date.now() - history.touchedAt <= timing.openFreshMs) void fetchHistory(id, 1).catch(() => {});
    else history.fetchedAt = 0;
  }

  let machinesRunning = false;
  async function refreshMachines() {
    const workspace = workspaceId;
    if (!workspace || machinesRunning || phase !== "ready") return;
    machinesRunning = true;
    try {
      // --include-agents is the CLI's older, unpaged output: it takes no --limit
      const json = await cli.json(["machine", "list", "--workspace", workspace, "--include-agents", "--json"], { priority: 1 });
      if (workspace !== workspaceId) return;
      const mapped = mapMachines(json, { userId: me.id, machineId: me.machineId });
      const differs = JSON.stringify(mapped.machines) !== JSON.stringify(machines);
      machines = mapped.machines;
      agents = mapped.agents;
      if (differs) {
        changes.snapshot();
        for (const id of histories.keys()) changes.session(id);
      }
    } catch (error) {
      log(`lody machine list failed: ${(error as Error).message}`);
    } finally {
      machinesAt = Date.now();
      machinesRunning = false;
    }
  }

  // --- a session's history -------------------------------------------------------------
  function fetchHistory(id: string, priority: Priority): Promise<void> {
    let held = histories.get(id);
    if (!held) {
      held = { limit: HISTORY_FIRST, fetchedAt: 0, touchedAt: Date.now() };
      histories.set(id, held);
    }
    const history = held;
    if (history.loading) {
      history.again = true;
      return history.loading;
    }
    const workspace = workspaceId;
    if (!workspace) return Promise.resolve();
    history.loading = (async () => {
      try {
        const started = Date.now();
        const json = await cli.json(["session", "history", id, "--workspace", workspace, "--limit", String(history.limit), "--json"], { priority });
        history.json = json;
        history.startedAt = started;
        history.fetchedAt = Date.now();
        settleLocals(id, json);
        changes.session(id);
        // a row's preview is its history's last line
        changes.snapshot();
        if (config.richTranscripts === "export") scheduleExport();
      } catch (error) {
        if (!history.json) histories.delete(id);
        throw error;
      } finally {
        history.loading = undefined;
        if (history.again && !closed) {
          history.again = false;
          void fetchHistory(id, 1).catch(() => {});
        }
      }
    })();
    return history.loading;
  }

  const entriesOf = (json: Json | undefined): Json[] => (Array.isArray(json?.entries) ? (json!.entries as Json[]) : []);

  /** A message this bridge sent stops being local once the history has it. */
  function settleLocals(id: string, json: Json) {
    const mine = locals.get(id);
    if (!mine) return;
    const there = new Set(entriesOf(json).map((entry) => entry.id));
    const left = mine.filter((local) => !(local.userTurnId && there.has(local.userTurnId)));
    if (left.length) locals.set(id, left);
    else locals.delete(id);
  }

  function previewOf(id: string): string | undefined {
    const entries = entriesOf(histories.get(id)?.json);
    const last = entries[entries.length - 1];
    return typeof last?.text === "string" && last.text ? oneLine(last.text) : undefined;
  }

  const rowOf = (meta: Json): SessionRow | undefined => {
    const id = meta.id as string;
    const preview = previewOf(id);
    return mapSessionRow(meta, { userId: me.id, observed: observed.get(id), readAt: saved.readAt[id], ...(preview ? { preview } : {}), projectName: (local) => projects.rows.find((row) => row.id === `local:${local}`)?.name });
  };

  // --- the whole workspace as files, for every item of a session -----------------------
  let exportAt = 0;
  let exporting = false;

  function scheduleExport() {
    const workspace = workspaceId;
    if (exporting || closed || !workspace || Date.now() - exportAt < timing.exportEveryMs) return;
    const wanting = [...histories.entries()].filter(([, history]) => history.json && history.rich?.total !== history.json.total);
    if (!wanting.length) return;
    exporting = true;
    const dir = join(cacheDir, "export");
    void (async () => {
      try {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const result = await cli.run(["export", "--offline", "--no-images", "--workspace", workspace, dir], { priority: 2, timeoutMs: 10 * 60_000 });
        if (result.code !== 0) throw new CliError(cleanError(result.stderr) || `exit ${result.code}`);
        for (const sub of readdirSync(dir)) {
          const index = join(dir, sub, "sessions", "index.json");
          if (!existsSync(index)) continue;
          for (const entry of JSON.parse(readFileSync(index, "utf8")) as { sessionId?: string; relativePath?: string }[]) {
            const history = entry.sessionId ? histories.get(entry.sessionId) : undefined;
            if (!history?.json || !entry.relativePath || entry.relativePath.includes("..")) continue;
            const file = join(dir, sub, entry.relativePath, "transcript.json");
            if (!existsSync(file) || statSync(file).size > EXPORT_FILE_MAX) continue;
            const transcript = JSON.parse(readFileSync(file, "utf8")) as Json;
            const meta = metas.get(entry.sessionId!);
            const turns = new Set((Array.isArray(transcript.turns) ? (transcript.turns as Json[]) : []).map((turn) => turn.turnId as string));
            history.rich = { items: mapExportTranscript(transcript, { userId: me.id, userName: me.name, ownerId: meta?.userId as string | undefined }), turns, total: Number(history.json.total ?? 0) };
            changes.session(entry.sessionId!);
          }
        }
      } catch (error) {
        log(`lody export failed: ${(error as Error).message}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        exportAt = Date.now();
        exporting = false;
      }
    })();
  }

  // --- the clock -----------------------------------------------------------------------
  const tick = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    if (phase === "unavailable" && !booting && now - bootAt > timing.retryBootMs) void boot();
    // someone signed in on the computer itself
    if (phase === "signed-out" && !signin?.child && !booting && now - bootAt > 5000 && accountStamp() !== signedOutStamp) void boot();
    if (phase !== "ready" || !workspaceId) return;
    if (!listRunning && !listTimer && now - listAt > (observe?.ready ? timing.listEveryMs : timing.listEveryDownMs)) void refreshList();
    if (now - machinesAt > timing.machinesEveryMs) void refreshMachines();
    for (const [id, history] of histories) {
      if (now - history.touchedAt > timing.forgetMs && !history.loading) {
        histories.delete(id);
        continue;
      }
      const meta = metas.get(id);
      if (!meta || history.loading || now - history.touchedAt > timing.openFreshMs || now - history.fetchedAt < timing.openRefreshMs) continue;
      const state = sessionState(meta, observed.get(id));
      if (state === "running" || state === "starting" || state === "waiting" || locals.has(id)) void fetchHistory(id, 1).catch(() => {});
    }
  }, timing.tickMs);
  (tick as { unref?: () => void }).unref?.();

  /** Resolves when `promise` does, or after `ms`. */
  const within = (promise: Promise<unknown> | undefined, ms: number) => (promise ? Promise.race([promise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]) : Promise.resolve());

  void boot();

  // --- the driver ------------------------------------------------------------------------
  let first = true;
  async function snapshot(): Promise<BackendSnapshot> {
    if (first) {
      first = false;
      await within(booting, timing.bootWaitMs);
    }
    if (phase !== "ready") return { link: link(), workspaces: [], machines: [], sessions: [] };
    const rows: SessionRow[] = [];
    for (const meta of metas.values()) {
      const row = rowOf(meta);
      if (row) rows.push(row);
    }
    return { link: link(), workspaces: workspaces.map(({ slug: _slug, ...row }) => row), ...(workspaceId ? { workspaceId } : {}), machines, sessions: capRows(rows, config.sessionLimit ?? SESSIONS_MAX, ARCHIVED_MAX) };
  }

  const NO_SESSION = "That session is not in this workspace any more; go back and pick another.";
  const NOT_READY = () => (phase === "signed-out" || phase === "signing-in" ? "Sign in to Lody on the bridge first." : (detail ?? "The bridge cannot reach Lody right now."));

  async function metaOf(sessionId: string): Promise<Json | undefined> {
    await within(booting, 20_000);
    if (phase !== "ready") return undefined;
    if (!listLoaded) await within(listRunning, 20_000);
    return metas.get(sessionId);
  }

  async function transcript(sessionId: string): Promise<BackendTranscript | null> {
    const meta = await metaOf(sessionId);
    if (!meta) return null;
    let history = histories.get(sessionId);
    if (!history?.json) {
      await fetchHistory(sessionId, 0);
      history = histories.get(sessionId);
      if (!history?.json) return null;
    } else if (history.fetchedAt === 0) void fetchHistory(sessionId, 1).catch(() => {}); // it changed while nobody had it open
    history.touchedAt = Date.now();
    const seen = observed.get(sessionId);
    let state = sessionState(meta, seen);
    // A turn ends in the observation seconds before its answer is in a
    // history this driver has read. Until a read that started after the end
    // is held, the session is still shown at work: the answer and "done"
    // then arrive together, and nothing reads as an empty turn.
    const ended = endedAt.get(sessionId);
    const catchingUp = (state === "idle" || state === "failed") && ended !== undefined && (history.startedAt ?? 0) < ended && Date.now() - ended < timing.catchUpMs;
    if (catchingUp) {
      state = "running";
      if (!history.loading) void fetchHistory(sessionId, 1).catch(() => {});
    } else if (ended !== undefined && (history.startedAt ?? 0) >= ended) endedAt.delete(sessionId);
    const mine = locals.get(sessionId) ?? [];
    const model = meta.lastModel && typeof meta.lastModel === "object" ? ((meta.lastModel as Json).name as string | undefined) : undefined;
    let items = mapHistory(history.json, { sessionId, userId: me.id, userName: me.name, ownerId: meta.userId as string | undefined, state, observed: catchingUp ? undefined : seen, awaiting: catchingUp || mine.some((local) => !local.error), ...(model ? { model } : {}) });
    if (history.rich) {
      const rich = history.rich;
      const ids = new Set(rich.items.map((item) => item.id));
      items = [...rich.items, ...items.filter((item) => !ids.has(item.id) && !rich.turns.has(item.id))];
    }
    for (const local of mine) {
      items.push(local.item);
      if (local.error) items.push({ k: "notice", id: `${local.item.id}:error`, turn: local.item.id, at: local.item.at, tone: "error", text: local.error });
    }
    const busy = state === "running" || state === "starting" || state === "waiting";
    const machine = machines.find((row) => row.id === meta.machineId);
    const active = seen?.activeTurns[0]?.userTurnId ?? (typeof meta.processingUserMsgId === "string" ? meta.processingUserMsgId : undefined);
    const total = Number(history.json.total ?? 0);
    return {
      state,
      can: { send: meta.isArchived !== true && machine?.online !== false, cancel: busy && !catchingUp, answer: false },
      ...(busy && active ? { activeTurn: active } : {}),
      items,
      complete: total <= entriesOf(history.json).length,
    };
  }

  async function older(sessionId: string): Promise<boolean> {
    const history = histories.get(sessionId);
    if (!history?.json) return false;
    const had = entriesOf(history.json).length;
    if (Number(history.json.total ?? 0) <= had || history.limit >= HISTORY_MAX) return false;
    history.limit = Math.min(HISTORY_MAX, history.limit * 2 + 40);
    await within(history.loading, 30_000);
    await fetchHistory(sessionId, 0);
    return entriesOf(histories.get(sessionId)?.json).length > had;
  }

  /** `run`'s refusal as a sentence, or its result. */
  async function acted(what: string, run: () => Promise<ActionResponse>): Promise<ActionResponse> {
    try {
      return await run();
    } catch (error) {
      const reason = (error as Error).message;
      if (isSignedOutError(reason)) signedOut();
      return refuse(`Lody did not ${what}: ${reason}`);
    }
  }

  async function send(request: BackendSend): Promise<ActionResponse> {
    const meta = await metaOf(request.session);
    if (!meta) return refuse(phase === "ready" ? NO_SESSION : NOT_READY());
    const workspace = workspaceId!;
    if (request.steer) return refuse("This bridge cannot steer a running turn. Send the message without steering to queue it, or steer in Lody on a phone or computer.");
    if (meta.isArchived === true) return refuse("This session is archived; restore it before sending to it.");
    const machine = machines.find((row) => row.id === meta.machineId);
    if (machine && !machine.online) return refuse(`${machine.name} is offline, so the message cannot reach it. Wake that computer, or start a session on another.`);
    const text = mentionText(request.text, request.mentions, { workspaceId: workspace, sessionTitle: (id) => metas.get(id)?.title as string | undefined, roleName: (id) => roles.rows.find((row) => row.id === id)?.label });
    const id = `local:${Date.now().toString(36)}:${++localIds}`;
    const local: LocalSend = { item: { k: "user", id, turn: id, at: Date.now(), text: request.text, ...(me.name ? { author: me.name } : {}), mine: true, delivery: "sending" } };
    locals.set(request.session, [...(locals.get(request.session) ?? []).filter((entry) => !entry.error), local]);
    changes.session(request.session);
    void (async () => {
      try {
        const json = await cli.json(["session", "chat", request.session, "--workspace", workspace, "--prompt-file", "-", "--json"], { stdin: text, priority: 0, timeoutMs: 120_000 });
        const { delivery: _sent, ...rest } = local.item;
        local.item = rest;
        // the bridge's own message is not news to its owner
        saved.readAt[request.session] = Date.now();
        local.userTurnId = typeof json.userTurnId === "string" ? json.userTurnId : undefined;
        if (!local.userTurnId) locals.set(request.session, (locals.get(request.session) ?? []).filter((entry) => entry !== local));
      } catch (error) {
        local.item = { ...local.item, delivery: "failed" };
        local.error = `Lody did not take the message: ${(error as Error).message}`;
      }
      if (closed) return;
      changes.session(request.session);
      scheduleList(true);
      void fetchHistory(request.session, 0).catch(() => {});
    })();
    return OK;
  }

  async function create(request: BackendCreate): Promise<ActionResponse> {
    if (phase !== "ready") return refuse(NOT_READY());
    const workspace = request.workspace ?? workspaceId;
    if (!workspace) return refuse("Pick a workspace before starting a session.");
    // these become arguments of a command: none may read as an option
    for (const value of [workspace, request.machine, request.agent, request.project, request.branch, request.title?.trim()]) if (value?.startsWith("-")) return refuse("That choice is not one this bridge knows; pick from the list.");
    const machine = machines.find((row) => row.id === request.machine);
    if (workspace === workspaceId && machine && !machine.online) return refuse(`${machine.name} is offline; pick another computer or wake it.`);
    const args = ["session", "create", "--workspace", workspace, "--machine", request.machine, "--agent", request.agent];
    const project = request.project;
    if (project?.startsWith("gh:")) args.push("--repo", project.slice(3));
    else if (project?.startsWith("local:")) {
      args.push("--local-project", project.slice(6));
      if (request.worktree) args.push("--worktree");
    } else if (project && project !== "chat") return refuse("That project is not one this bridge knows; pick one from the list.");
    if (request.branch && project && project !== "chat") args.push("--branch", request.branch);
    const title = (request.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (title) args.push("--title", title);
    const text = mentionText(request.text, undefined, { sessionTitle: () => undefined, roleName: () => undefined });
    return acted("start the session", async () => {
      const json = await cli.json([...args, "--prompt-file", "-", "--json"], { stdin: text, priority: 0, timeoutMs: 180_000 });
      const session = typeof json.sessionId === "string" ? json.sessionId : undefined;
      if (!session) return refuse("Lody started something but did not say which session; look for it in the list.");
      // The list and the history take seconds each to say what is known
      // here already: the session, and its first message. Held until they do,
      // so the session opens at once.
      if (workspace === workspaceId && !metas.has(session)) {
        const now = Date.now();
        const turnId = typeof json.userTurnId === "string" ? json.userTurnId : `${session}:first`;
        metas.set(session, { id: session, machineId: request.machine, createdAt: new Date(now).toISOString(), lastMessageAt: now, lastReadAt: now, title: title || oneLine(text.split("\n").find((line) => line.trim()) ?? "", 60), userId: me.id, status: { type: "initializing" }, agentConfigId: request.agent, ...(project?.startsWith("gh:") ? { repoFullName: project.slice(3) } : {}), latestUserMsgId: turnId, provisional: true });
        histories.set(session, { limit: HISTORY_FIRST, fetchedAt: 0, touchedAt: now, json: { ok: true, sessionId: session, total: 1, returned: 1, entries: [{ index: 0, id: turnId, role: "user", author: { v: 1, kind: "human", userId: me.id }, timestamp: new Date(now).toISOString(), text }] } });
        saved.readAt[session] = now;
        changes.snapshot();
        changes.session(session);
        void fetchHistory(session, 1).catch(() => {});
      }
      scheduleList(true);
      return { ok: true, session };
    });
  }

  /** One command on a session. `apply` changes what is held at once, so the
   *  row moves before the command (seconds) answers; it returns how to undo
   *  that, which is done when Lody refuses. `then` runs once Lody has agreed. */
  async function onSession(sessionId: string, what: string, args: (workspace: string) => string[], then: (meta: Json) => void, apply?: (meta: Json) => () => void): Promise<ActionResponse> {
    const meta = await metaOf(sessionId);
    if (!meta) return refuse(phase === "ready" ? NO_SESSION : NOT_READY());
    const workspace = workspaceId!;
    const undo = apply?.(meta);
    if (undo) {
      changes.snapshot();
      changes.session(sessionId);
    }
    const result = await acted(what, async () => {
      await cli.json(args(workspace), { priority: 0 });
      // the list may have been read again while the command ran
      then(metas.get(sessionId) ?? meta);
      changes.snapshot();
      changes.session(sessionId);
      scheduleList(true);
      return OK;
    });
    if (!result.ok && undo) {
      undo();
      changes.snapshot();
      changes.session(sessionId);
    }
    return result;
  }

  const cancel = (sessionId: string) => onSession(sessionId, "stop the session", (workspace) => ["session", "cancel", sessionId, "--workspace", workspace, "--json"], () => void fetchHistory(sessionId, 0).catch(() => {}));

  /** Sets `fields` on the sessions `pick` chooses, over any list read meanwhile; returns the undo. */
  function patch(pick: (entry: Json) => boolean, fields: Json): () => void {
    const undone: (() => void)[] = [];
    for (const entry of metas.values()) {
      if (!pick(entry)) continue;
      const id = entry.id as string;
      const before = Object.fromEntries(Object.keys(fields).map((key) => [key, entry[key]]));
      const patched = patches.get(id);
      Object.assign(entry, fields);
      patches.set(id, { fields: { ...patched?.fields, ...fields }, at: Date.now() });
      undone.push(() => {
        const now = metas.get(id);
        if (now) Object.assign(now, before);
        if (patched) patches.set(id, patched);
        else patches.delete(id);
      });
    }
    return () => undone.forEach((undo) => undo());
  }

  const archive = (sessionId: string, archived: boolean) =>
    onSession(
      sessionId,
      archived ? "archive the session" : "restore the session",
      (workspace) => ["session", archived ? "archive" : "restore", sessionId, "--workspace", workspace, "--json"],
      () => void patch((entry) => entry.id === sessionId || entry.parentSessionId === sessionId, { isArchived: archived }),
      () => patch((entry) => entry.id === sessionId || entry.parentSessionId === sessionId, { isArchived: archived }),
    );

  const rename = (sessionId: string, title: string) =>
    onSession(
      sessionId,
      "rename the session",
      (workspace) => ["session", "rename", sessionId, "--workspace", workspace, `--title=${title}`, "--json"],
      () => void patch((entry) => entry.id === sessionId, { title }),
      () => patch((entry) => entry.id === sessionId, { title }),
    );

  async function read(sessionId: string): Promise<ActionResponse> {
    const meta = await metaOf(sessionId);
    if (!meta) return refuse(phase === "ready" ? NO_SESSION : NOT_READY());
    const last = typeof meta.lastMessageAt === "number" ? meta.lastMessageAt : 0;
    const seen = Math.max(saved.readAt[sessionId] ?? -1, typeof meta.lastReadAt === "number" ? meta.lastReadAt : -1);
    if (seen >= last) return OK;
    saved.readAt[sessionId] = Math.max(Date.now(), last);
    save();
    changes.snapshot();
    return OK;
  }

  async function mentions(_query: MentionQuery): Promise<MentionRow[]> {
    const workspace = workspaceId;
    if (phase !== "ready" || !workspace) return [];
    if (!roles.loading && Date.now() - roles.at > timing.rolesTtlMs) {
      roles.loading = (async () => {
        try {
          const rows = mapRoles(await cli.json(["agent-role", "list", "--workspace", workspace, "--limit", "100", "--json"], { priority: 1 }));
          if (workspace === workspaceId) roles = { rows, at: Date.now() };
        } catch (error) {
          log(`lody agent-role list failed: ${(error as Error).message}`);
          roles = { rows: roles.rows, at: Date.now() };
        }
      })();
    }
    // the first @ waits a little for the roles; later ones answer from what is held
    if (roles.at === 0) await within(roles.loading, 2500);
    return roles.rows;
  }

  async function options(machineId?: string): Promise<CreateOptions> {
    const workspace = workspaceId;
    if (phase !== "ready" || !workspace) return { machines: [], agents: [], projects: [] };
    if (!machines.length) await refreshMachines();
    // the catalog takes most of a minute: it is read behind, and the projects the sessions name stand in
    if (!projects.loading && Date.now() - projects.at > timing.projectsTtlMs) {
      projects.loading = true;
      void (async () => {
        try {
          const rows = mapProjects(await cli.json(["project", "list", "--catalog", "--workspace", workspace, "--limit", "100", "--json"], { priority: 2, timeoutMs: 5 * 60_000 }));
          if (workspace === workspaceId) projects = { rows, at: Date.now() };
        } catch (error) {
          log(`lody project list failed: ${(error as Error).message}`);
          projects = { rows: projects.rows, at: Date.now() };
        }
      })();
    }
    const fromSessions = projectsOfSessions(metas.values());
    const known = new Map<string, CliProject>();
    for (const row of [...fromSessions, ...projects.rows]) known.set(row.id, { ...known.get(row.id), ...row });
    const rows = [...known.values()].filter((row) => !machineId || !row.machineId || row.machineId === machineId);
    return {
      machines,
      agents: agents.filter((agent) => !machineId || agent.machineId === machineId).map((agent) => ({ id: agent.id, name: agent.name, ...(agent.machineId ? { machineId: agent.machineId } : {}), ...(agent.detail ? { detail: agent.detail } : {}) })),
      projects: [...rows, { id: "chat", name: "No project", kind: "chat" as const }],
    };
  }

  async function workspace(id: string): Promise<ActionResponse> {
    if (phase !== "ready") return refuse(NOT_READY());
    const row = workspaces.find((entry) => entry.id === id);
    if (!row) return refuse("That workspace is not one this account belongs to.");
    if (row.locked) return refuse("That workspace is end-to-end encrypted; open it in Lody on a paired computer.");
    if (id === workspaceId) return OK;
    workspaceId = id;
    saved.workspaceId = id;
    save();
    changes.snapshot();
    void openWorkspace();
    return OK;
  }

  /** Commands the sign-in would start a browser with, answered by nothing. */
  function shims(): string {
    const dir = join(cacheDir, "shims");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of ["open", "xdg-open"]) {
      const file = join(dir, name);
      if (!existsSync(file)) writeFileSync(file, "#!/bin/sh\nexit 0\n");
      chmodSync(file, 0o755);
    }
    return dir;
  }

  async function signIn(): Promise<ActionResponse> {
    if (phase === "ready") return OK;
    if (phase === "unavailable") return refuse(detail ?? "The bridge cannot run the lody CLI.");
    if (signin?.child) return OK;
    let child: ChildProcess;
    try {
      // `lody login` opens the page itself; the handheld shows the link instead
      // --debug: the CLI then says when the code expires
      child = cli.long(["login", "--debug", ...(config.machineName ? ["--machine-name", config.machineName] : [])], { PATH: `${shims()}:${process.env.PATH ?? ""}`, BROWSER: "none" });
    } catch (error) {
      return refuse(`The sign-in could not start: ${(error as Error).message}`);
    }
    const attempt: NonNullable<typeof signin> = { child };
    signin = attempt;
    phase = "signing-in";
    detail = "Starting the sign-in…";
    changes.snapshot();
    let output = "";
    const listen = (chunk: string) => {
      output = (output + chunk).slice(-16384);
      if (signin !== attempt) return;
      const found = parseLoginOutput(output);
      if (!found || (attempt.url === found.url && attempt.expiresAt === found.expiresAt)) return;
      if (attempt.url !== found.url) attempt.qr = qrRows(found.url);
      attempt.url = found.url;
      attempt.code = found.code;
      attempt.expiresAt = found.expiresAt;
      detail = "Open the page on a phone or a computer and confirm the code to finish signing in.";
      changes.snapshot();
    };
    child.stdout!.setEncoding("utf8").on("data", listen);
    child.stderr!.setEncoding("utf8").on("data", listen);
    const started = Date.now();
    const ended = (code: number | null, how = "") => {
      if (signin !== attempt) return;
      signin = undefined;
      if (closed) return;
      const failure = code === 0 ? undefined : loginFailure(output);
      // the command, how it ended and how long it took: never what it printed
      log(`lody login: ${how || `exit ${code ?? "killed"}`} in ${Date.now() - started} ms${failure ? ` (${failure})` : ""}`);
      if (code === 0 && readAccount()) void boot();
      else signedOut(failure ?? "The sign-in did not finish. Start it again.");
    };
    child.on("close", (code, signal) => ended(code, signal ? `signal ${signal}` : ""));
    child.on("error", (error) => ended(1, `could not start (${(error as NodeJS.ErrnoException).code ?? "error"})`));
    return OK;
  }

  async function signOut(): Promise<ActionResponse> {
    if (phase === "signing-in" && signin?.child) {
      const child = signin.child;
      signin = undefined;
      child.kill("SIGTERM");
      signedOut();
      return OK;
    }
    if (phase !== "ready") return OK;
    if (!ownAccount) return refuse(`This bridge uses the Lody sign-in of ${me.machineName ?? hostname()} itself, which the Lody app there shares. Sign out on that computer with \`lody logout\`.`);
    return acted("sign out", async () => {
      const result = await cli.run(["logout"], { priority: 0 });
      if (result.code !== 0) throw new CliError(cleanError(result.stderr || result.stdout) || `exit ${result.code}`);
      signedOut();
      return OK;
    });
  }

  return {
    driver: "cli",
    snapshot,
    transcript,
    older,
    send,
    create,
    cancel,
    answer: async () => refuse("This bridge cannot answer a permission or a question. Answer it in Lody on a phone or computer."),
    archive,
    rename,
    read,
    mentions,
    options,
    workspace,
    signin: signIn,
    signout: signOut,
    subscribe: changes.subscribe,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(tick);
      if (listTimer) clearTimeout(listTimer);
      stopObserve();
      cli.close();
      changes.clear();
      rmSync(join(cacheDir, "export"), { recursive: true, force: true });
    },
  };
}
