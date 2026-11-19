// pocket-lody/app/create.tsx — starting a session: which machine runs it,
// which agent, in which project, and the first message. Each choice is a row
// that opens a menu of what the workspace has; the last choices are offered
// first.
import { createSignal, Show } from "solid-js";
import { Button, present, presentMenu, Row, Text, TextEditor, VStack, type EditorHandle, type UI } from "../vendor/pocketui/src/index.ts";
import type { CreateOptions } from "../protocol.ts";
import type { AppState } from "./state.ts";

export function presentCreate(ui: UI, app: AppState): void {
  const sheet = present(
    ui,
    () => {
      const [options, setOptions] = createSignal<CreateOptions | null>(null);
      const [failure, setFailure] = createSignal("");
      app.store.options().then(setOptions, (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
      const [machine, setMachine] = createSignal<string | undefined>();
      const [agent, setAgent] = createSignal<string | undefined>();
      const [project, setProject] = createSignal<string | undefined>();
      const [creating, setCreating] = createSignal(false);
      const [empty, setEmpty] = createSignal(true);
      let editor: EditorHandle | undefined;
      const machines = () => options()?.machines ?? [];
      const theMachine = () => machines().find((entry) => entry.id === machine()) ?? machines().find((entry) => entry.online && entry.mine) ?? machines().find((entry) => entry.online) ?? machines()[0];
      const agents = () => (options()?.agents ?? []).filter((entry) => !entry.machineId || entry.machineId === theMachine()?.id);
      const theAgent = () => agents().find((entry) => entry.id === agent()) ?? agents()[0];
      const projects = () => (options()?.projects ?? []).filter((entry) => !entry.machineId || entry.machineId === theMachine()?.id);
      const theProject = () => projects().find((entry) => entry.id === project()) ?? projects()[0];
      const choose = <T extends { id: string; name: string; detail?: string }>(title: string, list: T[], set: (id: string) => void, note?: (entry: T) => string | undefined) =>
        presentMenu(ui, { title, items: () => list.map((entry) => ({ id: entry.id, title: entry.name, detail: entry.detail, trailing: note?.(entry), run: () => set(entry.id) })) });
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
      return (
        <VStack>
          <Show when={options()} fallback={<Text tone="muted" padding={[10, ui.metric().gutter]}>{failure() || "Asking what this workspace has."}</Text>}>
            <Row title={theMachine()?.name ?? "No machine"} eyebrow="Machine" trailing={theMachine()?.online === false ? "offline" : undefined} disclosure onPress={() => choose("Machine", machines(), setMachine, (entry) => (entry.online ? undefined : "offline"))} name="create.machine" />
            <Row title={theAgent()?.name ?? "No agent on this machine"} eyebrow="Agent" disclosure onPress={() => choose("Agent", agents(), setAgent)} name="create.agent" />
            <Row title={theProject()?.name ?? "No project"} eyebrow="Project" disclosure onPress={() => choose("Project", projects(), setProject, (entry) => (entry.kind === "github" ? "GitHub" : entry.kind === "local" ? "local" : undefined))} name="create.project" />
            <VStack padding={[6, ui.metric().gutter, 10, ui.metric().gutter]} spacing={8}>
              <TextEditor ui={ui} part="field" placeholder="What should the agent do?" minLines={2} maxLines={4} enterSubmits={false} onChange={(snapshot) => setEmpty(snapshot.text.trim().length === 0)} handle={(handle) => { editor = handle; }} name="create.prompt" />
              <Button label={creating() ? "Starting" : "Start Session"} kind="filled" disabled={creating() || empty() || !theMachine() || !theAgent()} onPress={create} name="create.start" />
            </VStack>
          </Show>
        </VStack>
      );
    },
    { style: "sheet", title: "New Session", closeLabel: "Cancel", maxHeight: Math.round(ui.size().height * 0.94) },
  );
}
