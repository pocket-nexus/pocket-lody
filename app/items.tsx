// pocket-lody/app/items.tsx — one transcript item as elements: a person's
// message, the agent's prose, a tool call, a question waiting for an answer.
// Each is a function of the item (protocol.ts Item) and nothing else, so a
// row whose item did not change is not laid out again. What each looks like
// is the theme's: an item says it is a bubble, a card, a well, a remark.
import { For, Match, Show, Switch, type Accessor, type JSX } from "solid-js";
import { Badge, Bubble, Button, Callout, Card, Divider, Glyph, HStack, Label, Markdown, StatusDot, Text, useUI, VStack, Well, type Tone, type UIElement } from "@pocketjs/framework/ui";
import type { AskOption, DiffFile, Item, ToolKind, ToolStatus } from "../protocol.ts";
import { duration } from "./format.ts";
import type { AppState } from "./state.ts";

type Of<K extends Item["k"]> = Extract<Item, { k: K }>;

const TOOL_VERB: Record<ToolKind, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  search: ["Searching", "Searched"],
  execute: ["Running", "Ran"],
  fetch: ["Fetching", "Fetched"],
  think: ["Thinking", "Thought"],
  delegate: ["Delegating", "Delegated"],
  other: ["Working", "Done"],
};
const STATUS_TONE: Record<ToolStatus, Tone> = { pending: "muted", running: "accent", done: "good", failed: "bad" };

function UserItem(props: { item: Accessor<Of<"user">> }): UIElement {
  const ui = useUI();
  return (
    <HStack justify="end" align="start">
      <Bubble side={props.item().mine === false ? "other" : "self"} maxWidth={Math.round(ui.size().width * 0.6)} spacing={2}>
        <Show when={props.item().author && !props.item().mine}>
          <Text role="caption" tone="note" lines={1}>{props.item().author}</Text>
        </Show>
        <Text>{props.item().text}</Text>
        <Show when={props.item().delivery}>
          <Text role="caption" tone={props.item().delivery === "failed" ? "bad" : "faint"} lines={1}>
            {props.item().delivery === "queued" ? "Queued" : props.item().delivery === "sending" ? "Sending" : "Not delivered"}
          </Text>
        </Show>
      </Bubble>
    </HStack>
  ) as UIElement;
}

function ThoughtItem(props: { item: Accessor<Of<"thought">>; app: AppState }): UIElement {
  const open = () => props.app.unfolded().has(props.item().id);
  return (
    <VStack part="callout" spacing={2} onPress={() => props.app.toggleFold(props.item().id)}>
      <Text role="caption" tone="faint" lines={open() ? undefined : 2}>{props.item().text}</Text>
    </VStack>
  ) as UIElement;
}

function DiffSummary(props: { files: readonly DiffFile[] }): UIElement {
  return (
    <VStack spacing={1}>
      <For each={props.files}>
        {(file) => (
          <HStack spacing={6}>
            <Text role="mono" tone="good" lines={1}>{`+${file.added}`}</Text>
            <Text role="mono" tone="bad" lines={1}>{`-${file.removed}`}</Text>
            <Text role="mono" tone="muted" lines={1} grow={1}>{file.path}</Text>
          </HStack>
        )}
      </For>
    </VStack>
  ) as UIElement;
}

function ToolItem(props: { item: Accessor<Of<"tool">>; app: AppState }): UIElement {
  const open = () => props.app.unfolded().has(props.item().id);
  const lines = () => props.item().diff?.flatMap((file) => file.lines ?? []) ?? [];
  const foldable = () => !!props.item().output || lines().length > 0;
  return (
    <Card spacing={4} onPress={foldable() ? () => props.app.toggleFold(props.item().id) : undefined}>
      <HStack spacing={6}>
        <StatusDot tone={STATUS_TONE[props.item().status]} pulse={props.item().status === "running"} size={6} />
        <Text role="caption" tone="muted" lines={1}>{TOOL_VERB[props.item().kind][props.item().status === "done" || props.item().status === "failed" ? 1 : 0]}</Text>
        <Text role="strong" lines={1} grow={1}>{props.item().title}</Text>
        <Show when={foldable()}>
          <Glyph glyph={open() ? "up" : "down"} size={8} tone="faint" />
        </Show>
      </HStack>
      <Show when={props.item().detail}>
        <Text role="mono" tone="muted" lines={open() ? 6 : 1}>{props.item().detail}</Text>
      </Show>
      <Show when={props.item().diff?.length}>
        <DiffSummary files={props.item().diff!} />
      </Show>
      <Show when={open() && lines().length > 0}>
        <Markdown source={"```diff\n" + lines().slice(0, 60).join("\n") + "\n```"} />
      </Show>
      <Show when={open() && props.item().output}>
        <Well>
          <Text role="mono" tone="muted" lines={24}>{props.item().output}</Text>
        </Well>
      </Show>
    </Card>
  ) as UIElement;
}

const OPTION_KIND: Record<AskOption["kind"], { kind: "filled" | "tinted"; tone?: Tone }> = {
  allow: { kind: "filled" },
  "allow-always": { kind: "tinted", tone: "accent" },
  reject: { kind: "tinted", tone: "bad" },
  "reject-always": { kind: "tinted", tone: "bad" },
  answer: { kind: "tinted", tone: "accent" },
};

function AskItem(props: { item: Accessor<Of<"ask">>; app: AppState }): UIElement {
  const pending = () => props.item().outcome === undefined;
  const canAnswer = () => pending() && props.app.store.transcript()?.can.answer === true;
  const answer = (option: AskOption) => {
    const sessionId = props.app.selected();
    if (!sessionId) return;
    void props.app.store.act("/answer", { session: sessionId, requestId: props.item().requestId, option: option.id }).then((result) => {
      if (!result.ok) props.app.say(result.error ?? "The answer was not delivered.", true);
    });
  };
  return (
    <Card tone={pending() ? "warn" : undefined} spacing={5}>
      <HStack spacing={6}>
        <Badge label={props.item().question ? "Question" : "Permission"} tone={pending() ? "warn" : "muted"} />
        <Text role="strong" grow={1}>{props.item().title}</Text>
      </HStack>
      <Show when={props.item().detail}>
        <Text role="mono" tone="muted" lines={6}>{props.item().detail}</Text>
      </Show>
      <Show when={pending()} fallback={<Text role="caption" tone="muted">{`Answered: ${props.item().outcome}`}</Text>}>
        <Show when={canAnswer()} fallback={<Text role="caption" tone="warn">Waiting for an answer. Answer it in Lody on a phone or a computer.</Text>}>
          <VStack spacing={5}>
            <For each={props.item().options}>
              {(option) => <Button label={option.label} kind={OPTION_KIND[option.kind].kind} tone={OPTION_KIND[option.kind].tone} onPress={() => answer(option)} name={`ask.${option.id}`} />}
            </For>
          </VStack>
        </Show>
      </Show>
    </Card>
  ) as UIElement;
}

function PlanItem(props: { item: Accessor<Of<"plan">> }): UIElement {
  return (
    <Card spacing={3}>
      <Label>Plan</Label>
      <For each={props.item().entries}>
        {(entry) => (
          <HStack spacing={7} align="start">
            <VStack padding={[5, 0, 0, 0]}>
              <StatusDot tone={entry.status === "done" ? "good" : entry.status === "running" ? "accent" : "muted"} pulse={entry.status === "running"} size={6} />
            </VStack>
            <Text grow={1} tone={entry.status === "done" ? "muted" : "plain"}>{entry.text}</Text>
          </HStack>
        )}
      </For>
    </Card>
  ) as UIElement;
}

function NoticeItem(props: { item: Accessor<Of<"notice">>; app: AppState }): UIElement {
  const tone = (): Tone => (props.item().tone === "error" ? "bad" : props.item().tone === "done" ? "good" : "muted");
  const target = () => props.item().sessionId;
  return (
    <Callout tone={tone()} onPress={target() ? () => props.app.select(target()!) : undefined} trailing={target() ? <Text role="caption" tone="accent" lines={1}>Open</Text> : undefined}>
      <Text role="caption" tone={tone()}>{props.item().text}</Text>
    </Callout>
  ) as UIElement;
}

function TurnEnd(props: { item: Accessor<Of<"turn-end">> }): UIElement {
  const label = () => {
    const item = props.item();
    const what = item.outcome === "completed" ? "Worked" : item.outcome === "canceled" ? "Stopped" : "Failed";
    const parts = [item.durationMs !== undefined ? `${what} for ${duration(item.durationMs)}` : what];
    if (item.model) parts.push(item.model);
    return parts.join(" - ");
  };
  return (<Divider label={label()} tone={props.item().outcome === "failed" ? "bad" : "faint"} />) as UIElement;
}

/** One transcript row. */
export function ItemView(props: { item: Accessor<Item>; app: AppState }): JSX.Element {
  const item = props.item;
  return (
    <Switch>
      <Match when={item().k === "user"}><UserItem item={item as Accessor<Of<"user">>} /></Match>
      <Match when={item().k === "text"}><Markdown source={(item() as Of<"text">).text} /></Match>
      <Match when={item().k === "thought"}><ThoughtItem item={item as Accessor<Of<"thought">>} app={props.app} /></Match>
      <Match when={item().k === "tool"}><ToolItem item={item as Accessor<Of<"tool">>} app={props.app} /></Match>
      <Match when={item().k === "ask"}><AskItem item={item as Accessor<Of<"ask">>} app={props.app} /></Match>
      <Match when={item().k === "plan"}><PlanItem item={item as Accessor<Of<"plan">>} /></Match>
      <Match when={item().k === "notice"}><NoticeItem item={item as Accessor<Of<"notice">>} app={props.app} /></Match>
      <Match when={item().k === "turn-end"}><TurnEnd item={item as Accessor<Of<"turn-end">>} /></Match>
    </Switch>
  );
}
