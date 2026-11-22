// pocket-lody/app/app.tsx — Pocket Lody: a Lody workspace's sessions, their
// transcripts and a composer, written against PocketUI's semantics.
//
// What the application says, once:
//   three panes   the sessions, the open session, facts about it
//   commands      New Session, Stop, Session Info, Archive, Latest, …
//   a feed        the transcript, following its end
//   an entry      the composer, with @ naming sessions, files and roles
// How that looks on a surface (columns or one pane, a legend or bar
// controls, a sheet or a popover, typing in place or on a docked keyboard)
// is the surface's Environment and PocketUI's idioms (PocketJS framework/src/pocketui/core/env.ts).
import { createMemo, Show } from "solid-js";
import { confirm, Panes, presentMenu, Scaffold, Toast, useUI, ZStack, type Command, type EditorHandle, type UIElement } from "@pocketjs/framework/ui";
import { presentCreate } from "./create.tsx";
import { InfoPane } from "./info.tsx";
import { LinkPane } from "./link.tsx";
import { SessionPane } from "./session.tsx";
import { SessionList } from "./sessions.tsx";
import type { AppState } from "./state.ts";
import { THEMES } from "./themes.ts";

export function App(props: { app: AppState }): UIElement {
  const ui = useUI();
  const app = props.app;
  const store = app.store;
  let composer: EditorHandle | undefined;

  const listCommands = createMemo<Command[]>(() => {
    const snapshot = store.snapshot();
    const ready = snapshot?.link.phase === "ready";
    return [
      { id: "session.new", title: "New Session", short: "New", button: "action", key: "Control+n", bar: true, disabled: !ready, run: () => presentCreate(ui, app) },
      { id: "commands.menu", title: "Commands", short: "Menu", button: "option", run: () => ui.commands.openMenu?.() },
      {
        // the pad's way to move a session onto the message: pick it up here, put it down on the field
        id: "session.mention",
        title: "Mention in the Message",
        menu: "Session",
        disabled: app.selected() === null || app.focusedRow() === null || app.focusedRow() === app.selected() || !store.session(app.focusedRow() ?? ""),
        run: () => {
          const row = store.session(app.focusedRow() ?? "");
          if (row) ui.transfer.carry({ type: "session", id: row.id, label: `@${row.title || "Untitled session"}` });
        },
      },
      {
        id: "workspace.switch",
        title: "Switch Workspace",
        disabled: (snapshot?.workspaces.length ?? 0) < 2,
        run: () =>
          presentMenu(ui, {
            title: "Workspace",
            items: () => (store.snapshot()?.workspaces ?? []).map((workspace) => ({ id: workspace.id, title: workspace.name, checked: workspace.id === store.snapshot()?.workspaceId, disabled: workspace.locked, detail: workspace.locked ? "End-to-end encrypted: open it in Lody." : undefined, run: () => { app.select(null); void store.act("/workspace", { id: workspace.id }); } })),
          }),
      },
      { id: "sync.retry", title: "Refresh", key: "Control+r", menu: "View", run: () => store.retry() },
      {
        id: "view.theme",
        title: "Theme",
        key: "Control+t",
        menu: "View",
        run: () =>
          presentMenu(ui, {
            title: "Theme",
            items: () => THEMES.map((theme) => ({ id: theme.id, title: theme.label, checked: theme.id === app.theme(), run: () => app.setTheme(theme.id) })),
          }),
      },
      {
        id: "account.signout",
        title: "Sign Out",
        destructive: true,
        disabled: !ready || snapshot?.link.ownAccount !== true,
        run: () => confirm(ui, { title: "Sign out of Lody?", message: "This device stops showing the workspace until someone signs in again.", action: "Sign Out", destructive: true, run: () => void store.act("/signout", {}) }),
      },
    ];
  });

  const sessionCommands = createMemo<Command[]>(() => {
    const id = app.selected();
    if (!id) return [];
    const transcript = store.transcript();
    const row = store.session(id);
    const act = (path: Parameters<typeof store.act>[0], body: Record<string, unknown>, done: string) =>
      void store.act(path, body).then((result) => app.say(result.ok ? done : (result.error ?? "That did not work."), !result.ok));
    return [
      { id: "session.stop", title: "Stop the Agent", short: "Stop", button: "action", key: "Control+.", bar: true, menu: "Session", destructive: true, disabled: transcript?.sessionId !== id || !transcript.can.cancel, run: () => act("/cancel", { session: id }, "Stopping") },
      { id: "session.info", title: "Session Info", short: "Info", key: "Control+i", bar: true, menu: "Session", checked: app.inspector(), run: () => app.setInspector(!app.inspector()) },
      { id: "session.compose", title: "Write a Message", short: "Write", key: "Control+l", menu: "Session", run: () => composer?.focus() },
      {
        id: "session.archive",
        title: row?.archived ? "Restore from Archive" : "Archive",
        key: "Control+Alt+a",
        menu: "Session",
        run: () => {
          act("/archive", { session: id, archived: !row?.archived }, row?.archived ? "Restored" : "Archived");
          if (!row?.archived) app.select(null);
        },
      },
    ];
  });

  const depth = () => (app.selected() === null ? 0 : app.inspector() ? 2 : 1);
  /** There is a workspace to show, or one is on its way: the panes. Otherwise the link pane takes the frame. */
  const linked = () => {
    const link = store.link();
    if (!link) return true;
    if (link.setup && (link.setup.state !== "needed" || link.phase !== "ready")) return false;
    return link.phase === "ready";
  };
  /** one line about the workspace, for themes whose frame has a status bar */
  const status = () => {
    if (store.connection() === "offline") return "Not connected";
    const snapshot = store.snapshot();
    if (!snapshot || snapshot.link.phase !== "ready" || snapshot.link.setup?.state === "running" || snapshot.link.setup?.state === "failed") return "";
    const working = snapshot.sessions.filter((row) => row.state === "running" || row.state === "starting").length;
    const name = snapshot.workspaces.find((entry) => entry.id === snapshot.workspaceId)?.name;
    return `${name ? `${name}: ` : ""}${snapshot.sessions.length} sessions${working > 0 ? `, ${working} working` : ""}`;
  };
  return (
    <ZStack>
      <Scaffold title="Lody" document={app.selected() ? store.session(app.selected()!)?.title || "Untitled session" : undefined} status={status()} closable onClose={app.selected() !== null ? () => app.select(null) : undefined}>
        <Panes
          hidden={!linked()}
          depth={depth()}
          onClose={(pane) => (pane === "inspector" ? app.setInspector(false) : app.select(null))}
          list={<SessionList app={app} commands={listCommands} />}
          detail={<SessionPane app={app} commands={sessionCommands} composer={(handle) => { composer = handle; }} />}
          inspector={<InfoPane app={app} commands={sessionCommands} />}
        />
        {/* no workspace to show: what it takes to have one, across the whole frame */}
        <Show when={!linked()}>
          <LinkPane app={app} />
        </Show>
      </Scaffold>
      <Show when={app.notice()}>
        <Toast text={app.notice()!.text} tone={app.notice()!.failed ? "bad" : undefined} />
      </Show>
    </ZStack>
  ) as UIElement;
}
