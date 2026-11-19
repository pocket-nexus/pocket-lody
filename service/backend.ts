// pocket-lody/service/backend.ts — what a driver gives the service.
//
// A driver (fixture.ts, cli.ts, remote.ts) knows where a Lody workspace's
// data comes from. It answers with what it holds NOW and says when that
// changed; it keeps no revisions, holds no requests and joins no drafts. The
// service (service.ts) owns those: it compares what a driver answers with
// what it answered before, numbers the differences, and holds /sync until a
// number moves.
//
// The rules a driver keeps:
//  - `snapshot()` and `transcript()` are cheap to call again and again. A
//    driver whose source is slow answers from what it has cached and
//    refreshes behind, then emits a change.
//  - Nothing throws for a state a person can be in (signed out, offline, no
//    such session). Those are `link.phase`, `null`, or `{ok: false, error}`
//    with one sentence the person can act on. A throw is a bug or a broken
//    transport, and the service answers it as a 502.
//  - An item keeps its id for its life. An item that did not change MAY be
//    the same object as last time, which saves the service a comparison.

import type { ActionResponse, CreateOptions, CreateRequest, Item, Link, MachineRow, MentionRow, SendRequest, SessionRow, SessionState, Snapshot, Transcript, WorkspaceRow } from "../protocol.ts";

/** A Snapshot without its revision: the service numbers it. */
export type BackendSnapshot = Omit<Snapshot, "rev">;

/** Everything the driver holds of one session, oldest first. */
export interface BackendTranscript {
  state: SessionState;
  can: Transcript["can"];
  activeTurn?: string;
  items: Item[];
  /** `items[0]` is the session's first item. When false, `older()` may bring more. */
  complete: boolean;
}

export type BackendChange =
  /** the workspace's rows, machines, workspaces or the link changed */
  | { kind: "snapshot" }
  /** this session's items, state or `can` changed */
  | { kind: "session"; id: string };

/** A message with its draft already joined into `text`. */
export type BackendSend = Omit<SendRequest, "draft" | "text"> & { text: string };
export type BackendCreate = Omit<CreateRequest, "draft" | "text"> & { text: string };

export interface MentionQuery {
  text: string;
  /** the session being written in, whose project's files an @ can name */
  session?: string;
  kind?: MentionRow["kind"];
}

export interface LodyBackend {
  /** "fixture", "cli", "remote": `Link.driver` */
  readonly driver: string;

  snapshot(): Promise<BackendSnapshot>;
  /** The session's items as held, or null when the workspace has no such session. */
  transcript(sessionId: string): Promise<BackendTranscript | null>;
  /** Bring items older than the ones held. False when there are none, or the driver cannot. */
  older(sessionId: string): Promise<boolean>;

  send(request: BackendSend): Promise<ActionResponse>;
  create(request: BackendCreate): Promise<ActionResponse>;
  cancel(sessionId: string): Promise<ActionResponse>;
  answer(request: { session: string; requestId: string; option: string; text?: string }): Promise<ActionResponse>;
  archive(sessionId: string, archived: boolean): Promise<ActionResponse>;
  rename(sessionId: string, title: string): Promise<ActionResponse>;
  read(sessionId: string): Promise<ActionResponse>;

  /** What an @ can name besides the workspace's sessions (the service adds
   *  those from the snapshot): files and roles, unranked. */
  mentions(query: MentionQuery): Promise<MentionRow[]>;
  options(machineId?: string): Promise<CreateOptions>;

  workspace(id: string): Promise<ActionResponse>;
  signin(): Promise<ActionResponse>;
  signout(): Promise<ActionResponse>;
  /** Fetch what `link.setup` offers. Only a bridge that offers it has this. */
  setup?(): Promise<ActionResponse>;

  /** `listener` hears every change until the returned function is called. */
  subscribe(listener: (change: BackendChange) => void): () => void;
  close(): void;
}

/** The subscription half of a driver. */
export class Changes {
  private readonly listeners = new Set<(change: BackendChange) => void>();

  subscribe = (listener: (change: BackendChange) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  emit(change: BackendChange) {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  snapshot() {
    this.emit({ kind: "snapshot" });
  }

  session(id: string) {
    this.emit({ kind: "session", id });
  }

  clear() {
    this.listeners.clear();
  }
}

export const refuse = (error: string): ActionResponse => ({ ok: false, error });
export const OK: ActionResponse = { ok: true };

/** A driver that could not start: every read is empty, the link says why,
 *  and every action answers the same sentence. */
export function unavailableBackend(driver: string, detail: string, via?: string): LodyBackend {
  const link: Link = { phase: "unavailable", driver, detail, ...(via ? { via } : {}) };
  const no = async () => refuse(detail);
  return {
    driver,
    snapshot: async () => ({ link, workspaces: [] as WorkspaceRow[], machines: [] as MachineRow[], sessions: [] as SessionRow[] }),
    transcript: async () => null,
    older: async () => false,
    send: no,
    create: no,
    cancel: no,
    answer: no,
    archive: no,
    rename: no,
    read: no,
    mentions: async () => [],
    options: async () => ({ machines: [], agents: [], projects: [] }),
    workspace: no,
    signin: no,
    signout: no,
    subscribe: () => () => {},
    close() {},
  };
}
