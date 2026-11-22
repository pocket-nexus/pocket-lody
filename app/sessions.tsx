// pocket-lody/app/sessions.tsx — the list pane: the workspace's sessions,
// what needs a person first (format.ts groupSessions).
import { createMemo, Match, onCleanup, Show, Switch, type Accessor } from "solid-js";
import { Bar, Button, Card, Feed, Placeholder, Row, Section, StatusDot, Text, useCommands, useUI, VStack, type Command, type Instance, type UIElement } from "@pocketjs/framework/ui";
import type { SessionRow } from "../protocol.ts";
import { age, groupSessions, sessionDetail, STATE_TONE } from "./format.ts";
import type { AppState } from "./state.ts";

type ListRow = { key: string; section: string; count: number } | { key: string; session: SessionRow };

export function SessionList(props: { app: AppState; commands: Accessor<Command[]> }): UIElement {
  const ui = useUI();
  const app = props.app;
  const store = app.store;
  let pane: Instance | undefined;
  useCommands(props.commands, { id: "list", within: () => pane });
  const rows = createMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    for (const group of groupSessions(store.sessions(), app.filter())) {
      out.push({ key: `section:${group.id}`, section: group.title, count: group.rows.length });
      for (const session of group.rows) out.push({ key: session.id, session });
    }
    return out;
  });
  const workspace = () => {
    const snapshot = store.snapshot();
    return snapshot?.workspaces.find((entry) => entry.id === snapshot.workspaceId)?.name ?? "Lody";
  };
  const subtitle = () => {
    if (store.connection() === "offline") return "Not connected";
    const link = store.link();
    if (!link) return "Connecting";
    if (link.phase !== "ready") return link.phase === "unavailable" ? "Unavailable" : "Signed out";
    const count = store.sessions().filter((row) => row.state === "running" || row.state === "starting").length;
    return count > 0 ? `${count} working` : link.via ? `Through ${link.via}` : "Up to date";
  };
  return (
    <VStack ref={(instance) => { pane = instance; }}>
      <Bar title={workspace()} subtitle={subtitle()} commands={props.commands()} back={false} />
      {/* sample data, on a device that could fetch what a real account needs */}
      <Show when={store.link()?.phase === "ready" && store.link()?.setup?.state === "needed"}>
        <VStack padding={[6, ui.metric().gutter]}>
          <Card spacing={5}>
            <Text role="caption" tone="muted">These are sample sessions. This device can reach your own Lody account.</Text>
            <Button label="Set Up Lody" kind="filled" onPress={() => void store.act("/setup", {})} name="link.setup" />
          </Card>
        </VStack>
      </Show>
      <Switch>
        <Match when={store.connection() === "offline" && !store.snapshot()}>
          <Placeholder title="The Lody service is not answering" detail={store.failure()} action={{ label: "Try Again", run: () => store.retry() }} />
        </Match>
        <Match when={!store.snapshot()}>
          <Placeholder title="Connecting" detail="Asking the Lody service for your workspace." />
        </Match>
        <Match when={rows().length === 0}>
          <Placeholder title={app.filter() ? "No session matches" : "No sessions yet"} detail={app.filter() ? "Clear the filter to see every session." : "Start one with New."} />
        </Match>
        <Match when={true}>
          <Feed grow={1} each={rows()} by={(row) => row.key} estimate={ui.metric().rowPad * 2 + 32} name="sessions">
            {(row) => (
              <Show when={"session" in row() ? (row() as { session: SessionRow }).session : null} fallback={<Section title={(row() as { section: string }).section} trailing={String((row() as { count: number }).count)} />} keyed>
                {(session) => (
                  <Row
                    title={session.title || "Untitled session"}
                    detail={sessionDetail(session)}
                    trailing={age(session.updatedAt, app.now())}
                    leading={<StatusDot tone={session.unread && session.state === "idle" ? "accent" : STATE_TONE[session.state]} pulse={session.state === "running" || session.state === "starting"} />}
                    selected={app.selected() === session.id}
                    strong={session.unread === true || session.state !== "idle"}
                    dim={session.state === "idle" && !session.unread}
                    onPress={() => app.select(session.id)}
                    onFocus={(focused) => focused && app.setFocusedRow(session.id)}
                    ref={(instance) => onCleanup(ui.transfer.source(() => instance, () => ({ type: "session", id: session.id, label: `@${session.title || "Untitled session"}` })))}
                    name={`session.${session.id}`}
                  />
                )}
              </Show>
            )}
          </Feed>
        </Match>
      </Switch>
    </VStack>
  ) as UIElement;
}
