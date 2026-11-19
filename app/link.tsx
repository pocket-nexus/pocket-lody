// pocket-lody/app/link.tsx — what stands in for the workspace while this
// device has none: fetching what the bridge needs, signing in, and the
// reasons it cannot (protocol.ts Link).
//
// Signing in is Lody's device flow. The bridge asks for a code; the page
// that confirms it is opened on a phone or a computer that is signed in, by
// its QR code or its address, and the workspace arrives here when it is
// confirmed. Nothing is typed on this device.
import { Match, Show, Switch } from "solid-js";
import { Button, Card, HStack, Label, MatrixCode, Placeholder, Progress, Scroll, Text, useUI, VStack, type UIElement } from "../vendor/pocketui/src/index.ts";
import type { AppState } from "./state.ts";

/** "9:41" until `at`, or "" once it has passed. */
function remaining(at: number | undefined, now: number): string {
  if (at === undefined) return "";
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  // a code is good for minutes: anything longer is two clocks that disagree, and no countdown is better than a wrong one
  return seconds <= 0 || seconds > 3600 ? "" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The page's address as a person reads it out: no scheme, no code in it. */
const spoken = (url: string) => url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "");

export function LinkPane(props: { app: AppState }): UIElement {
  const ui = useUI();
  const app = props.app;
  const store = app.store;
  const link = () => store.link();
  const act = (path: "/signin" | "/signout" | "/setup") => void store.act(path, {}).then((result) => !result.ok && app.say(result.error ?? "That did not work.", true));
  // the clock for the code's countdown: the applet's own, a second at a time while a code shows
  const left = () => remaining(link()?.expiresAt, app.clock());
  const wide = () => ui.size().width >= 420;
  return (
    <VStack grow={1} name="link">
      <Switch>
        <Match when={link()?.setup?.state === "running"}>
          <VStack grow={1} justify="center" padding={[20, 24]} spacing={10} align="center">
            <Text role="title" align="center">Setting up Lody on this device</Text>
            <Text tone="muted" align="center" maxWidth={320}>{link()?.setup?.step ?? "Starting."}</Text>
            <Progress value={progressOf(link()?.setup?.step)} width={220} />
          </VStack>
        </Match>
        <Match when={link()?.setup?.state === "failed"}>
          <Placeholder title="The setup did not finish" detail={link()?.setup?.step ?? "Something went wrong while fetching Lody."} action={{ label: "Try Again", run: () => act("/setup") }} />
        </Match>
        <Match when={link()?.setup?.state === "needed"}>
          <Placeholder title="Set up Lody on this device" detail={link()?.detail ?? "This device can reach your Lody account by itself. It fetches the Lody command-line client first: about 90 MB."} action={{ label: "Set Up", run: () => act("/setup") }} />
        </Match>
        <Match when={link()?.phase === "signing-in"}>
          <Scroll grow={1}>
          <VStack padding={[14, 20]} spacing={10} align="center">
            <Text role="title" align="center">Confirm on a phone or a computer</Text>
            <Show when={link()?.url} fallback={<Text tone="muted" align="center">{link()?.detail ?? "Starting the sign-in."}</Text>}>
              <Card>
                {/* side by side where there is room, the code under the picture where there is not */}
                <Show
                  when={wide()}
                  fallback={
                    <VStack spacing={8} align="center">
                      <Show when={link()?.qr}><MatrixCode rows={link()!.qr!} module={3} /></Show>
                      <Code app={app} left={left()} />
                    </VStack>
                  }
                >
                  <HStack spacing={16} align="center">
                    <Show when={link()?.qr}><MatrixCode rows={link()!.qr!} module={3} /></Show>
                    <Code app={app} left={left()} />
                  </HStack>
                </Show>
              </Card>
            </Show>
            <Button label="Cancel" onPress={() => act("/signout")} name="link.cancel" />
          </VStack>
          </Scroll>
        </Match>
        <Match when={link()?.phase === "signed-out"}>
          <Placeholder title="Sign in to Lody" detail={link()?.detail ?? `${link()?.machine ?? "This device"} is not signed in to Lody.`} action={{ label: "Sign In", run: () => act("/signin") }} />
        </Match>
        <Match when={true}>
          <Placeholder title="Lody is not reachable" detail={link()?.detail ?? "The bridge could not reach Lody."} action={{ label: "Try Again", run: () => store.retry() }} />
        </Match>
      </Switch>
    </VStack>
  ) as UIElement;
}

function Code(props: { app: AppState; left: string }): UIElement {
  const link = () => props.app.store.link();
  return (
    <VStack spacing={3} maxWidth={230}>
      <Text tone="muted">Scan the code with a phone that is signed in to Lody, or open</Text>
      <Text role="strong">{spoken(link()?.url ?? "")}</Text>
      <VStack height={3} />
      <Label>The code to confirm there</Label>
      <Text role="title" name="link.code">{link()?.code ?? ""}</Text>
      <Text role="caption" tone="faint">{`${props.left ? `Good for ${props.left}. ` : ""}${link()?.machine ? `Signs in as ${link()!.machine}.` : ""}`}</Text>
    </VStack>
  ) as UIElement;
}

/** "Downloading Node (12 of 30 MB)" as a share, where the step says one. */
function progressOf(step: string | undefined): number {
  const found = step?.match(/(\d+(?:\.\d+)?) of (\d+(?:\.\d+)?)/);
  if (!found) return 0;
  const total = Number(found[2]);
  return total > 0 ? Number(found[1]) / total : 0;
}
