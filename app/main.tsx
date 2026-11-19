// @title Lody
// pocket-lody/app/main.tsx — the applet's entry: PocketUI on the applet's
// surface, the workspace store over the worker's transport, run-time glyphs.
import { AppletSurface } from "@pocketjs/framework/applet";
import { resizeAuxiliarySurface } from "@pocketjs/framework/display";
import { mount } from "@pocketjs/framework/solid";
import { createRenderEffect } from "solid-js";
import { PocketUI, type UI } from "../vendor/pocketui/src/index.ts";
import { App } from "./app.tsx";
import { installFaces } from "./faces.ts";
import { memory, transport } from "./net.ts";
import { createAppState, type AppState } from "./state.ts";
import { themeById } from "./themes.ts";

/** Omarchy Pocket's shell gives a window's applet its tile's size, and a new one when the tile changes (host/src/children.rs). */
type Hooks = { __omarchyResized?: (width: number, height: number) => void; __pocketLody?: AppState; __pocketUISetTheme?: (id: string) => void };

mount(() => {
  const hooks = globalThis as Hooks;
  installFaces();
  // one state for the realm: the workspace, the open session, the drafts
  const app = (hooks.__pocketLody ??= createAppState(transport, memory));
  let ui: UI | undefined;
  hooks.__omarchyResized = (width, height) => {
    resizeAuxiliarySurface(width, height);
    ui?.resize(width, height);
  };
  return (
    <AppletSurface>
      <PocketUI
        facts={{ glyphs: "runtime" }}
        theme={themeById(app.theme())}
        ready={(ready) => {
          ui = ready;
          // for a simulator's `theme:` step (vendor/pocketui/tools/sim.ts)
          hooks.__pocketUISetTheme = (id) => app.setTheme(id);
          // the reader's theme, and every later choice of one: the same tree, painted again
          createRenderEffect(() => ready.setTheme(themeById(app.theme())));
        }}
      >
        {() => <App app={app} />}
      </PocketUI>
    </AppletSurface>
  );
});
