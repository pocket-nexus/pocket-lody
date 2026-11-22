// pocket-lody/app/create.tsx — starting a session: which machine runs it,
// which agent, in which project, and the first message.
//
// The form says what it is made of and nothing about how it looks: three
// choices (Picker), a field, and what the task does and its way out
// (present's `actions`). Whether a choice is a row that opens a list or a
// label beside a popup, and whether Start is a wide button under the form or
// the default button beside Cancel at its foot, is the theme's.
import { createSignal, Show } from "solid-js";
import { Picker, present, Text, TextEditor, VStack, type EditorHandle, type UI } from "@pocketjs/framework/ui";
import type { CreateOptions } from "../protocol.ts";
import type { AppState } from "./state.ts";

export function presentCreate(ui: UI, app: AppState): void {
  const [options, setOptions] = createSignal<CreateOptions | null>(null);
  const [failure, setFailure] = createSignal("");
  const [machine, setMachine] = createSignal<string | undefined>();
  const [agent, setAgent] = createSignal<string | undefined>();
  const [project, setProject] = createSignal<string | undefined>();
  const [creating, setCreating] = createSignal(false);
  const [empty, setEmpty] = createSignal(true);
  let editor: EditorHandle | undefined;
  app.store.options().then(setOptions, (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
  const machines = () => options()?.machines ?? [];
  const theMachine = () => machines().find((entry) => entry.id === machine()) ?? machines().find((entry) => entry.online && entry.mine) ?? machines().find((entry) => entry.online) ?? machines()[0];
  const agents = () => (options()?.agents ?? []).filter((entry) => !entry.machineId || entry.machineId === theMachine()?.id);
  const theAgent = () => agents().find((entry) => entry.id === agent()) ?? agents()[0];
  const projects = () => (options()?.projects ?? []).filter((entry) => !entry.machineId || entry.machineId === theMachine()?.id);
  const theProject = () => projects().find((entry) => entry.id === project()) ?? projects()[0];
  const create = () => {
    const text = editor?.model.value().text.trim() ?? "";
    const m = theMachine();
    const a = theAgent();
    if (!m || !a || creating()) return;
    setCreating(true);
    void app.store.create({ machine: m.id, agent: a.id, project: theProject()?.kind === "chat" ? undefined : theProject()?.id, text }).then((result) => {
      setCreating(false);
      if (!result.ok) return app.say(result.error ?? "The session was not started.", true);
      sheet.dismiss();
      if (result.session) app.select(result.session);
    });
  };
  const sheet = present(
    ui,
    () => (
      <VStack>
        <Show when={options()} fallback={<Text tone="muted" padding={[10, ui.metric().gutter + 4]}>{failure() || "Asking what this workspace has."}</Text>}>
          <Picker
            label="Machine"
            value={theMachine()?.name}
            placeholder="No machine"
            note={theMachine()?.online === false ? "offline" : undefined}
            selected={theMachine()?.id}
            options={() => machines().map((entry) => ({ id: entry.id, title: entry.name, trailing: entry.online ? undefined : "offline" }))}
            onPick={setMachine}
            autoFocus
            name="create.machine"
          />
          <Picker
            label="Agent"
            value={theAgent()?.name}
            placeholder="No agent on this machine"
            selected={theAgent()?.id}
            options={() => agents().map((entry) => ({ id: entry.id, title: entry.name, detail: entry.detail }))}
            onPick={setAgent}
            disabled={agents().length === 0}
            name="create.agent"
          />
          <Picker
            label="Project"
            value={theProject()?.name}
            placeholder="No project"
            selected={theProject()?.id}
            options={() => projects().map((entry) => ({ id: entry.id, title: entry.name, trailing: entry.kind === "github" ? "GitHub" : entry.kind === "local" ? "local" : undefined }))}
            onPick={setProject}
            name="create.project"
          />
          <VStack padding={[6, ui.metric().gutter + 4, 4, ui.metric().gutter + 4]}>
            <TextEditor ui={ui} part="field" placeholder="What should the agent do?" minLines={2} maxLines={4} enterSubmits={false} onChange={(snapshot) => setEmpty(snapshot.text.trim().length === 0)} handle={(handle) => { editor = handle; }} name="create.prompt" />
          </VStack>
        </Show>
      </VStack>
    ),
    {
      style: "sheet",
      title: "New Session",
      maxHeight: Math.round(ui.size().height * 0.94),
      actions: () => [
        { label: "Cancel", role: "cancel" },
        { label: creating() ? "Starting" : "Start Session", role: "primary", disabled: creating() || empty() || !theMachine() || !theAgent(), run: create },
      ],
    },
  );
}
