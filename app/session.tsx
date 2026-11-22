// pocket-lody/app/session.tsx — the detail pane: one session's transcript,
// following its end while the reader is there, and the composer under it.
import { createEffect, createMemo, createSignal, on, onCleanup, Show, type Accessor } from "solid-js";
import { Bar, Button, Feed, HStack, Placeholder, StatusDot, useCommands, useUI, VStack, ZStack, type Command, type EditorHandle, type FeedHandle, type Instance, type UIElement } from "@pocketjs/framework/ui";
import type { Item } from "../protocol.ts";
import { Composer } from "./composer.tsx";
import { STATE_LABEL, STATE_TONE } from "./format.ts";
import { ItemView } from "./items.tsx";
import type { AppState } from "./state.ts";

export function SessionPane(props: { app: AppState; commands: Accessor<Command[]>; composer?: (handle: EditorHandle | undefined) => void }): UIElement {
  const ui = useUI();
  const app = props.app;
  const store = app.store;
  let pane: Instance | undefined;
  useCommands(props.commands, { id: "session", within: () => pane });
  const row = () => {
    const id = app.selected();
    return id ? store.session(id) : undefined;
  };
  const transcript = () => {
    const held = store.transcript();
    return held && held.sessionId === app.selected() ? held : null;
  };
  const items = createMemo<readonly Item[]>(() => transcript()?.items ?? []);
  const subtitle = () => {
    const session = row();
    if (!session) return "";
    const parts: string[] = [];
    if (session.project) parts.push(session.project);
    if (session.branch) parts.push(session.branch);
    parts.push(STATE_LABEL[transcript()?.state ?? session.state]);
    return parts.join(" - ");
  };
  return (
    <VStack ref={(instance) => { pane = instance; }}>
      {/* nothing open: the pane still has its bar, which a theme whose bars are one surface draws and the others leave out */}
      <Show when={app.selected()} fallback={<VStack grow={1}><Bar title="" back={false} /><Placeholder title="No session open" detail="Pick a session from the list to read it and answer its agent." /></VStack>} keyed>
        {(sessionId) => {
          let feed: FeedHandle | undefined;
          const [atEnd, setAtEnd] = createSignal(true);
          // where the reader was is kept when the session is left
          onCleanup(() => {
            if (feed) app.positions.set(sessionId, feed.position());
            props.composer?.(undefined);
          });
          // a message the reader just sent brings the end into view
          createEffect(on(() => items().length, (count, before) => {
            if (before === undefined || count <= before) return;
            const last = items()[count - 1];
            if (last?.k === "user" && last.mine) feed?.toEnd();
          }));
          return (
            <VStack grow={1}>
              <Bar
                title={row()?.title || "Session"}
                subtitle={subtitle()}
                leading={<StatusDot tone={STATE_TONE[transcript()?.state ?? row()?.state ?? "idle"]} pulse={(transcript()?.state ?? row()?.state) === "running"} />}
                commands={props.commands()}
              />
              <ZStack grow={1}>
                <Show when={!transcript()?.loading} fallback={<Placeholder title="Loading the conversation" />}>
                  <Show when={items().length > 0} fallback={<Placeholder title="Nothing said yet" detail="Write the first message below." />}>
                    <Feed
                      each={items()}
                      by={(item) => item.id}
                      padding={[10, ui.metric().gutter + 2]}
                      spacing={9}
                      estimate={70}
                      followEnd={!app.positions.get(sessionId)}
                      position={app.positions.get(sessionId) ?? null}
                      onNearStart={() => store.loadOlder()}
                      onAtEnd={setAtEnd}
                      handle={(handle) => { feed = handle; }}
                      name="transcript"
                    >
                      {(item) => <ItemView item={item} app={app} />}
                    </Feed>
                  </Show>
                </Show>
                <Show when={!atEnd()}>
                  <HStack anchor="bottom" padding={[0, 0, 8, 0]}>
                    <Button
                      kind="pill"
                      label="Latest"
                      leading={<Show when={(transcript()?.state ?? "idle") === "running"}><StatusDot tone="accent" pulse size={6} /></Show>}
                      focusable={false}
                      onPress={() => feed?.toEnd()}
                      name="transcript.latest"
                    />
                  </HStack>
                </Show>
              </ZStack>
              <Composer app={app} sessionId={sessionId} handle={(handle) => props.composer?.(handle)} />
            </VStack>
          );
        }}
      </Show>
    </VStack>
  ) as UIElement;
}
