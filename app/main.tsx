// @title Lody
// pocket-lody/app/main.tsx — the applet's entry: PocketUI on the applet's
// surface, the workspace store over the worker's transport, run-time glyphs.
import { resizeAuxiliarySurface } from "@pocketjs/framework/display";
import { mountPocketUI } from "@pocketjs/framework/ui";
import { createRenderEffect } from "solid-js";
import { App } from "./app.tsx";
import { installFaces, prefetchText } from "./faces.ts";
import { memory, transport } from "./net.ts";
import { createAppState, type AppState } from "./state.ts";
import { themeById } from "./themes.ts";

/** Omarchy Pocket's shell gives a window's applet its tile's size, and a new one when the tile changes (host/src/children.rs). PocketUI follows the surface (display.ts onAuxiliaryViewport). */
type Hooks = { __omarchyResized?: (width: number, height: number) => void; __pocketLody?: AppState; __pocketUISetTheme?: (id: string) => void };

mountPocketUI(() => {
  const hooks = globalThis as Hooks;
  hooks.__omarchyResized = (width, height) => resizeAuxiliarySurface(width, height);
  const text = installFaces();
  // one state for the realm: the workspace, the open session, the drafts
  const app = (hooks.__pocketLody ??= createAppState(transport, memory));
  // the characters of what arrives, fetched before they are scrolled to
  prefetchText(text, [() => app.store.sessions(), () => app.store.transcript()?.items]);
  return {
    facts: { glyphs: "runtime" },
    theme: themeById(app.theme()),
    ready(ui) {
      // for a simulator's `theme:` step (PocketJS tools/pocketui-sim.ts)
      hooks.__pocketUISetTheme = (id) => app.setTheme(id);
      // the reader's theme, and every later choice of one: the same tree, painted again
      createRenderEffect(() => ui.setTheme(themeById(app.theme())));
    },
    children: () => <App app={app} />,
  };
});
