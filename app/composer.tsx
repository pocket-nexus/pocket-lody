// pocket-lody/app/composer.tsx — where a message is written: the field, the
// @ menu over it, and Send. A session's unsent text is its draft (state.ts)
// and is there again when the session is opened again.
//
// Typing "@" and then letters asks the service what can be named (sessions,
// files, roles); the answers list above the field, Up and Down move through
// them and Enter or a tap puts one in as a token, which the field treats as
// one character from then on.
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Button, Divider, HStack, Text, TextEditor, useUI, VStack, type EditorHandle, type EditorSnapshot, type Instance, type UIElement } from "@pocketjs/framework/ui";
import type { MentionRow } from "../protocol.ts";
import type { AppState } from "./state.ts";

const KIND_LABEL: Record<MentionRow["kind"], string> = { session: "Session", file: "File", role: "Role" };

export function Composer(props: { app: AppState; sessionId: string; handle?: (handle: EditorHandle) => void }): UIElement {
  const ui = useUI();
  const app = props.app;
  let editor: EditorHandle | undefined;
  const [empty, setEmpty] = createSignal(true);
  const [typing, setTyping] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [trigger, setTrigger] = createSignal<{ start: number; end: number; query: string } | null>(null);
  const [rows, setRows] = createSignal<MentionRow[]>([]);
  const [picked, setPicked] = createSignal(0);
  const transcript = () => app.store.transcript();
  const busy = () => transcript()?.state === "running" || transcript()?.state === "starting";
  // what a session takes is known once its transcript arrived; until then the field is open
  const canSend = () => transcript()?.loading === true || transcript()?.can.send !== false;

  // ask for completions as the query changes; the answer for an older query is dropped
  let asked = 0;
  createEffect(
    on(
      () => trigger()?.query,
      (query) => {
        if (query === undefined) return setRows([]);
        const mine = ++asked;
        void app.store.mentions(query, props.sessionId).then((found) => {
          if (mine !== asked) return;
          setRows(found.filter((row) => row.id !== props.sessionId).slice(0, 5));
          setPicked(0);
        });
      },
    ),
  );

  const changed = (snapshot: EditorSnapshot) => {
    setEmpty(snapshot.text.length === 0);
    const value = editor!.model.value();
    if (value.text.length > 0) app.drafts.set(props.sessionId, value);
    else app.drafts.delete(props.sessionId);
    setTrigger(editor!.model.trigger(["@"]));
  };

  const pick = (row: MentionRow) => {
    const at = trigger();
    if (!at || !editor) return;
    editor.model.insertToken({ kind: row.kind, id: row.id, label: `@${row.label}` }, { start: at.start, end: at.end });
    setTrigger(null);
  };

  const send = () => {
    if (!editor || sending()) return;
    const value = editor.model.value();
    const text = value.text.trim();
    if (text.length === 0) return;
    // tokens as offsets into the trimmed text
    const lead = value.text.length - value.text.trimStart().length;
    setSending(true);
    void app.store
      .send({ session: props.sessionId, text, mentions: value.tokens.map((token) => ({ start: token.start - lead, end: token.end - lead, kind: token.kind as MentionRow["kind"], id: token.id })) })
      .then((result) => {
        setSending(false);
        if (!result.ok) return app.say(result.error ?? "The message was not sent.", true);
        editor?.clear();
        app.drafts.delete(props.sessionId);
      });
  };

  // a session dropped here (dragged from the list, or carried with the pad) is named in the message
  let field: Instance | undefined;
  const dropping = () => {
    const item = ui.transfer.carrying();
    return item !== null && item.type === "session" && item.id !== props.sessionId;
  };
  onCleanup(
    ui.transfer.target({
      within: () => field,
      accepts: (item) => item.type === "session" && item.id !== props.sessionId,
      drop: (item) => {
        editor?.model.insertToken({ kind: "session", id: item.id, label: item.label });
        editor?.focus();
      },
    }),
  );

  /** The menu takes the keys that move and choose while it is open. */
  const interceptKey = (key: string): boolean => {
    const list = rows();
    if (!trigger() || list.length === 0) return false;
    if (key === "ArrowDown") return setPicked((picked() + 1) % list.length), true;
    if (key === "ArrowUp") return setPicked((picked() + list.length - 1) % list.length), true;
    if (key === "Enter" || key === "Tab") return pick(list[picked()]!), true;
    if (key === "Escape") return setTrigger(null), true;
    return false;
  };

  return (
    <VStack>
      <Divider />
      <Show when={trigger() && rows().length > 0}>
        <VStack part="menu" variant="inline">
          <For each={rows()}>
            {(row, index) => (
              <HStack part="menu.item" selected={index() === picked()} spacing={8} focusable={false} onPress={() => pick(row)} name={`mention.${row.id}`}>
                <Text role="caption" tone="note" lines={1} width={46}>{KIND_LABEL[row.kind]}</Text>
                <Text lines={1} grow={1}>{row.label}</Text>
                <Show when={row.detail}>
                  <Text role="caption" tone="faint" lines={1} maxWidth={140}>{row.detail}</Text>
                </Show>
              </HStack>
            )}
          </For>
        </VStack>
      </Show>
      <HStack part="bar" variant="footer" align="end" padding={[6, ui.metric().gutter - 2, 6, ui.metric().gutter]} spacing={8}>
        <TextEditor
          ui={ui}
          grow={1}
          part="field"
          selected={typing()}
          tone={dropping() ? "good" : undefined}
          ref={(instance) => { field = instance; }}
          placeholder={dropping() ? "Drop here to mention it" : canSend() ? (busy() ? "Add to the queue" : "Message the agent") : "This session takes no messages here"}
          disabled={!canSend()}
          maxLines={5}
          maxLength={8000}
          initial={app.drafts.get(props.sessionId)}
          onChange={changed}
          onTyping={setTyping}
          onSubmit={send}
          interceptKey={interceptKey}
          handle={(handle) => {
            editor = handle;
            setEmpty(handle.model.isEmpty());
            props.handle?.(handle);
          }}
          name="composer"
        />
        <Button label={sending() ? "Sending" : busy() ? "Queue" : "Send"} kind="filled" disabled={empty() || sending() || !canSend()} onPress={send} name="composer.send" />
      </HStack>
    </VStack>
  ) as UIElement;
}
