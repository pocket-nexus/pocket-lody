// pocket-lody/protocol.ts — what the applet and the `lody` companion service
// say to each other. The service (pocket-lody/service) projects a Lody
// workspace into rows the applet draws as they are: the applet's realm is
// QuickJS on a handheld, so it sorts, groups and lays out and does not join
// or derive.
//
// Transport limits this is shaped by (PocketJS docs/WORKER.md): one request
// (URL, method, headers and body as JSON) is at most 1020 bytes, a response
// arrives whole, and nothing streams. A change reaches the applet by a held
// request: GET /sync names the revisions the applet has and is answered when
// one is behind, or after `wait` seconds with the same revisions.
//
// Every path is under https://companion.pocket/lody. Times are Unix ms.

/** Bumped when a response's shape changes in a way an older applet cannot read. */
export const PROTOCOL = 1;

// ---------------------------------------------------------------------------
// The link: where the workspace's data comes from, and whether it is signed in.
// ---------------------------------------------------------------------------

export type LinkPhase =
  /** signed in and syncing */
  | "ready"
  /** no account on the bridge: `url` and `code` start a device sign-in */
  | "signed-out"
  /** a sign-in is waiting for the owner at `url` */
  | "signing-in"
  /** the bridge cannot reach Lody or its CLI: `detail` says why */
  | "unavailable";

export interface Link {
  phase: LinkPhase;
  /** "fixture" (sample data), "cli" (the lody CLI on this computer), "remote" (a bridge on another computer) */
  driver: string;
  /** the computer the data comes through, for "Linked through …" */
  via?: string;
  user?: { name: string; email?: string };
  /** the page that completes a sign-in, and the code to confirm there */
  url?: string;
  code?: string;
  /** `url` as a QR code for a phone to open: one string a row, top to
   *  bottom, "1" a dark module and "0" a light one, with no quiet zone (draw
   *  two light modules around it). 29 rows for a usual sign-in page. */
  qr?: string[];
  /** when the code stops being accepted, Unix ms: a sign-in started again gives a new one */
  expiresAt?: number;
  /** the name this device signs in as (the machine Lody lists it under), known before the sign-in */
  machine?: string;
  /** the bridge holds an account of its own that /signout ends; absent where
   *  the sign-in is a computer's own and is ended there */
  ownAccount?: boolean;
  /** one sentence a person can act on */
  detail?: string;
  /** The bridge can fetch what it needs to reach a Lody account from this
   *  device (the Lody CLI and a Node it runs on, about 90 MB): POST /setup
   *  starts it. "needed": not started; "running": `step` says what it is
   *  doing; "failed": `step` says why, and /setup tries again. Absent once it
   *  is done, and on a bridge that needs none. While it is offered the other
   *  fields describe what is shown meanwhile (sample data, or nothing). */
  setup?: { state: "needed" | "running" | "failed"; step?: string };
}

// ---------------------------------------------------------------------------
// The workspace snapshot: everything the sidebar and the pickers show.
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  name: string;
  /** end-to-end encrypted: listed, never opened */
  locked?: boolean;
}

export interface MachineRow {
  id: string;
  name: string;
  online: boolean;
  mine?: boolean;
}

/** What a session is doing, as its row shows it. `waiting` is a permission
 *  or a question waiting for a person; `failed` is a latest turn that failed. */
export type SessionState = "idle" | "starting" | "running" | "waiting" | "failed";

export interface SessionRow {
  id: string;
  title: string;
  state: SessionState;
  createdAt: number;
  /** the last message, else creation */
  updatedAt: number;
  /** has messages newer than the owner's last read */
  unread?: boolean;
  mine?: boolean;
  archived?: boolean;
  pinned?: boolean;
  machineId?: string;
  /** the agent's name: "Claude", "Codex" */
  agent?: string;
  model?: string;
  /** "owner/repo" or a local project's name; absent for a plain chat */
  project?: string;
  branch?: string;
  /** a child tab of this session */
  parentId?: string;
  /** opened by this session (a delegated one) */
  openedById?: string;
  prs?: { url: string; number?: number; state: "open" | "closed" | "merged"; draft?: boolean }[];
  /** the last visible text, one line */
  preview?: string;
}

export interface Snapshot {
  /** grows by at least one on every change */
  rev: number;
  link: Link;
  workspaces: WorkspaceRow[];
  workspaceId?: string;
  machines: MachineRow[];
  sessions: SessionRow[];
}

// ---------------------------------------------------------------------------
// A session's transcript.
// ---------------------------------------------------------------------------

export type ToolKind = "read" | "edit" | "search" | "execute" | "fetch" | "think" | "delegate" | "other";
export type ToolStatus = "pending" | "running" | "done" | "failed";

interface ItemBase {
  /** stable for the item's life; an item that changes keeps its id */
  id: string;
  /** the turn it belongs to: a user item's own id, or the user turn an agent's items answer */
  turn: string;
  at: number;
}

export type Item =
  /** a person's (or another session's) message */
  | (ItemBase & { k: "user"; text: string; author?: string; mine?: boolean; delivery?: "queued" | "sending" | "failed"; attachments?: number })
  /** the agent's prose, as Markdown; `streaming` while it is still being written */
  | (ItemBase & { k: "text"; text: string; streaming?: boolean; final?: boolean })
  | (ItemBase & { k: "thought"; text: string })
  /** one tool call: `title` is what it is doing, `detail` a command or a path, `output` the tail of what came back */
  | (ItemBase & { k: "tool"; kind: ToolKind; title: string; status: ToolStatus; detail?: string; output?: string; diff?: DiffFile[] })
  /** a permission or a question waiting for a person; `outcome` once answered */
  | (ItemBase & { k: "ask"; requestId: string; title: string; detail?: string; options: AskOption[]; outcome?: string; question?: boolean })
  | (ItemBase & { k: "plan"; entries: { text: string; status: "pending" | "running" | "done" }[] })
  /** a line the system wrote: a failure and its reason, a fork, a delegation's result */
  | (ItemBase & { k: "notice"; tone: "info" | "error" | "done"; text: string; sessionId?: string })
  /** the end of an agent's turn: how long it worked, with which model */
  | (ItemBase & { k: "turn-end"; outcome: "completed" | "failed" | "canceled"; durationMs?: number; model?: string });

export interface AskOption {
  id: string;
  label: string;
  kind: "allow" | "allow-always" | "reject" | "reject-always" | "answer";
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  /** unified-diff lines of the first hunks, each starting with " ", "+", "-" or "@" */
  lines?: string[];
}

export interface Transcript {
  sessionId: string;
  /** grows on every change to this session's items or state */
  rev: number;
  state: SessionState;
  /** what the composer can do now */
  can: { send: boolean; cancel: boolean; answer: boolean };
  /** the turn being worked on, for Stop */
  activeTurn?: string;
  /** older items exist before `items[0]`: ask with `before=<items[0].id>` */
  older: boolean;
  /** with `rev` in the request: the items that changed since, in transcript
   *  order, to be merged by id; `order` then lists every id held, oldest
   *  first. Without `rev`: the newest page, and no `order`. */
  items: Item[];
  order?: string[];
}

// ---------------------------------------------------------------------------
// Requests.
// ---------------------------------------------------------------------------

/** GET /sync?rev=<n>[&session=<id>&srev=<m>][&wait=<seconds, at most 25>]
 *  `snapshot` when the workspace is past `rev`; `transcript` when the session
 *  is past `srev`. Both absent: nothing changed within `wait`. */
export interface SyncResponse {
  protocol: number;
  rev: number;
  snapshot?: Snapshot;
  transcript?: Transcript;
}

/** GET /session?id=<id>[&before=<item id>][&limit=<n, default 40>]: a page of items, oldest first. */
export type SessionResponse = Transcript;

/** GET /mentions?q=<text>[&session=<id>][&kind=session|file|role]: what an @ can name, best first, at most 12. */
export interface MentionRow {
  kind: "session" | "file" | "role";
  /** what is inserted: a session id, a path, a role id */
  id: string;
  label: string;
  detail?: string;
}

/** GET /options[?machine=<id>]: what a new session can be made of. */
export interface CreateOptions {
  machines: MachineRow[];
  agents: { id: string; name: string; machineId?: string; detail?: string }[];
  projects: { id: string; name: string; kind: "github" | "local" | "chat"; machineId?: string }[];
}

/** POST /draft?id=<draft id>&part=<n> with a text/plain body: one part of a
 *  prompt too long for one request. Parts are joined in order when a /send
 *  or /create names the draft. */

/** POST /send {session, text?, draft?, mentions?}: a message to a session.
 *  While the session is busy the message is queued unless `steer`. */
export interface SendRequest {
  session: string;
  text?: string;
  draft?: string;
  /** the @ tokens in the text, in order: `start` and `end` are UTF-16 offsets into it */
  mentions?: { start: number; end: number; kind: MentionRow["kind"]; id: string }[];
  steer?: boolean;
}

/** POST /create {…}: a new session, with its first message. */
export interface CreateRequest {
  workspace?: string;
  machine: string;
  agent: string;
  project?: string;
  branch?: string;
  worktree?: boolean;
  /** the session's title; default: Lody makes one from the first message */
  title?: string;
  text?: string;
  draft?: string;
}

/** POST /cancel {session}, /answer {session, requestId, option, text?},
 *  /archive {session, archived}, /rename {session, title}, /read {session},
 *  /workspace {id}, /signin {} (start a device sign-in: the link then carries
 *  `url`, `code` and `expiresAt`), /signout {} (end the bridge's own account,
 *  or call off a sign-in that is waiting), /setup {} (fetch what `link.setup`
 *  offers). */
export interface ActionResponse {
  ok: boolean;
  /** one sentence a person can act on, when not ok */
  error?: string;
  /** the session a /create made */
  session?: string;
}
