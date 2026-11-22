// pocket-lody/app/state.ts — what the application remembers that is not the
// workspace's: which session is open, where the reader was in each
// transcript, each session's unsent draft, what is unfolded. One object for
// the realm, so a pane that is rebuilt (another session opened, a different
// idiom) finds its state as it left it.
import { createSignal, type Accessor } from "solid-js";
import type { FeedAnchor, Token } from "@pocketjs/framework/ui";
import { createLodyStore, type LodyStore, type Transport } from "./store.ts";

export interface Draft {
  text: string;
  tokens: Token[];
}

export interface AppState {
  store: LodyStore;
  selected: Accessor<string | null>;
  select(id: string | null): void;
  inspector: Accessor<boolean>;
  setInspector(open: boolean): void;
  filter: Accessor<string>;
  setFilter(value: string): void;
  /** where the reader was in a session's transcript; absent: at the end */
  positions: Map<string, FeedAnchor | null>;
  drafts: Map<string, Draft>;
  /** transcript items shown unfolded */
  unfolded: Accessor<ReadonlySet<string>>;
  toggleFold(id: string): void;
  /** the time, moving once every 20 seconds: ages are redrawn then */
  now: Accessor<number>;
  /** the time, moving once a second while a sign-in code is shown (its countdown) */
  clock: Accessor<number>;
  /** the session row the d-pad's focus was last on, for commands that act on it */
  focusedRow: Accessor<string | null>;
  setFocusedRow(id: string | null): void;
  /** the theme the reader chose (pocketui themes' ids) */
  theme: Accessor<string>;
  setTheme(id: string): void;
  /** a line said to the reader for a moment */
  notice: Accessor<{ text: string; failed: boolean } | null>;
  say(text: string, failed?: boolean): void;
}

/** What survives the applet being closed: where the reader was. */
export interface Memory {
  load<T>(name: string): Promise<T | null>;
  save(name: string, value: unknown): void;
}

interface Remembered {
  theme?: string;
  workspace?: string;
  selected?: string | null;
  inspector?: boolean;
}

export function createAppState(transport: Transport, memory?: Memory): AppState {
  const store = createLodyStore(transport);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [inspector, setInspector] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [unfolded, setUnfolded] = createSignal<ReadonlySet<string>>(new Set());
  const [now, setNow] = createSignal(Date.now());
  const [notice, setNotice] = createSignal<{ text: string; failed: boolean } | null>(null);
  const [focusedRow, setFocusedRow] = createSignal<string | null>(null);
  const [theme, setTheme] = createSignal("pocket");
  let cancelNotice: (() => void) | null = null;
  const tick = () => {
    setNow(Date.now());
    transport.after(20, tick);
  };
  transport.after(20, tick);
  const [clock, setClock] = createSignal(Date.now());
  const second = () => {
    if (store.link()?.phase === "signing-in") setClock(Date.now());
    transport.after(1, second);
  };
  transport.after(1, second);
  const remember = () => memory?.save("lody.state", { theme: theme(), workspace: store.snapshot()?.workspaceId, selected: selected(), inspector: inspector() } satisfies Remembered);
  const select = (id: string | null) => {
    if (id === selected()) return;
    setSelected(id);
    if (id === null) setInspector(false);
    store.open(id);
    if (id) void store.act("/read", { session: id });
    remember();
  };
  // the session that was open when the applet was last closed opens again, if nothing was opened
  // meanwhile and the workspace still has it
  let themeChosen = false;
  void memory?.load<Remembered>("lody.state").then((kept) => {
    if (kept?.theme && !themeChosen) setTheme(kept.theme);
    if (!kept?.selected) return;
    const wanted = kept.selected;
    const reopen = () => {
      if (selected() !== null) return;
      const snapshot = store.snapshot();
      if (!snapshot) return void transport.after(0.5, reopen);
      if (kept.workspace !== undefined && kept.workspace !== snapshot.workspaceId) return;
      if (!snapshot.sessions.some((row) => row.id === wanted)) return;
      select(wanted);
      if (kept.inspector) setInspector(true);
    };
    reopen();
  });
  return {
    store,
    selected,
    select,
    inspector,
    setInspector(open) {
      setInspector(open);
      remember();
    },
    filter,
    setFilter,
    positions: new Map(),
    drafts: new Map(),
    unfolded,
    toggleFold(id) {
      const next = new Set(unfolded());
      if (!next.delete(id)) next.add(id);
      setUnfolded(next);
    },
    now,
    clock,
    focusedRow,
    setFocusedRow,
    theme,
    setTheme(id) {
      themeChosen = true;
      setTheme(id);
      remember();
    },
    notice,
    say(text, failed = false) {
      cancelNotice?.();
      setNotice({ text, failed });
      cancelNotice = transport.after(failed ? 5 : 2.5, () => setNotice(null));
    },
  };
}
