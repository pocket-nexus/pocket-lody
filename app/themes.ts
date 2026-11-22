// pocket-lody/app/themes.ts — the themes Pocket Lody offers: PocketUI's, with
// Classic set in the pixel face this application's pack carries (pak.json).
import { CLASSIC_THEME, PIXEL_FACES, THEMES as STOCK, withFaces, type Theme } from "@pocketjs/framework/ui";

export const THEMES: readonly Theme[] = STOCK.map((theme) => (theme.id === CLASSIC_THEME.id ? withFaces(theme, PIXEL_FACES) : theme));

export function themeById(id: string | undefined): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}
