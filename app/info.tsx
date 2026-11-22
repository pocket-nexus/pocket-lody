// pocket-lody/app/info.tsx — the inspector: facts about the open session
// and what can be done to it as a whole.
import { For, Show } from "solid-js";
import { Bar, Button, Divider, Fact, HStack, Row, Scroll, Section, StatusDot, Text, useUI, VStack, type Command, type UIElement } from "@pocketjs/framework/ui";
import { age, STATE_LABEL, STATE_TONE } from "./format.ts";
import type { AppState } from "./state.ts";

export function InfoPane(props: { app: AppState; commands: () => Command[] }): UIElement {
  const ui = useUI();
  const app = props.app;
  const row = () => {
    const id = app.selected();
    return id ? app.store.session(id) : undefined;
  };
  const machine = () => app.store.snapshot()?.machines.find((entry) => entry.id === row()?.machineId);
  const children = () => app.store.sessions().filter((entry) => entry.parentId === app.selected() || entry.openedById === app.selected());
  return (
    <VStack>
      <Bar title="Session" commands={[]} />
      <Scroll grow={1}>
        <Show when={row()} keyed>
          {(session) => (
            <VStack>
              <HStack padding={[8, ui.metric().gutter, 4, ui.metric().gutter]} spacing={7}>
                <StatusDot tone={STATE_TONE[session.state]} pulse={session.state === "running"} />
                <Text role="strong" lines={1}>{STATE_LABEL[session.state]}</Text>
              </HStack>
              <Fact label="Agent" value={[session.agent, session.model].filter(Boolean).join(" - ") || undefined} />
              <Fact label="Machine" value={machine() ? `${machine()!.name}${machine()!.online ? "" : " (offline)"}` : undefined} />
              <Fact label="Project" value={session.project} />
              <Fact label="Branch" value={session.branch} />
              <Fact label="Updated" value={`${age(session.updatedAt, app.now())} ago`} />
              <Fact label="Started" value={`${age(session.createdAt, app.now())} ago`} />
              <Show when={session.prs?.length}>
                <Section title="Pull requests" />
                <For each={session.prs}>
                  {(pr) => (
                    <HStack padding={[4, ui.metric().gutter]} spacing={8}>
                      <StatusDot tone={pr.state === "merged" ? "note" : pr.state === "open" ? "good" : "bad"} size={6} />
                      <Text grow={1} lines={1}>{pr.number ? `#${pr.number}` : "Pull request"}</Text>
                      <Text role="caption" tone="muted" lines={1}>{pr.draft ? "draft" : pr.state}</Text>
                    </HStack>
                  )}
                </For>
              </Show>
              <Show when={children().length > 0}>
                <Section title="Opened from here" />
                <For each={children()}>
                  {(child) => (
                    <Row title={child.title} strong={false} leading={<StatusDot tone={STATE_TONE[child.state]} pulse={child.state === "running"} size={6} />} disclosure onPress={() => app.select(child.id)} />
                  )}
                </For>
              </Show>
              <VStack height={8} />
              <Divider />
              <VStack padding={[8, ui.metric().gutter]} spacing={6}>
                <For each={props.commands().filter((command) => command.id !== "session.info")}>
                  {(command) => <Button label={command.title} kind="tinted" tone={command.destructive ? "bad" : "accent"} disabled={command.disabled} onPress={command.run} name={`info.${command.id}`} />}
                </For>
              </VStack>
            </VStack>
          )}
        </Show>
      </Scroll>
    </VStack>
  ) as UIElement;
}
