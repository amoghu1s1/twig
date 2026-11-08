/**
 * THE FIRST-PAINT THEME (theme wave, 2026-11-04; light/system wave,
 * 2026-10-29): what app/layout.tsx puts on <html> before any client code
 * runs — the record's appearance, the active theme (a preset or an imported
 * file; Default when the id is gone) and its color variables with every
 * override applied, PLUS the display mode (dark/light/system) that drives
 * the class, data-lh-mode and the pre-paint System script. One disk read of
 * the record and the theme dir per request (the layout calls connection()
 * first, so this never bakes into a prerender).
 */

import {
	effectiveColors,
	FACTORY_SETTINGS,
	resolveRenderedMode,
	resolveTheme,
	themeVars,
	type AppearanceMode,
	type AppearanceSettings,
	type RenderedMode,
	type Theme,
} from "../core";
import { themeStore } from "../store/themes.ts";
import { readSettings } from "../store/settings.ts";

/** Everything the layout needs for a flash-free first paint. */
export interface ThemeBoot {
	appearance: AppearanceSettings | undefined;
	theme: Theme;
	/** The raw display mode from the record (dark | light | system). */
	mode: AppearanceMode;
	/** The variant the server renders into <html className>. The server
	 *  cannot know the OS, so System falls back to dark here — the inline
	 *  <head> script (SYSTEM_MODE_SCRIPT) corrects it before first paint. */
	renderedMode: RenderedMode;
	/** The CSS variables for <html style>. */
	vars: Record<string, string>;
}

/** Read the record and the theme dir; resolve the active theme, the display
 *  mode and their vars. */
export function readThemeBoot(): ThemeBoot {
	const appearance = readSettings()?.appearance;
	const theme = resolveTheme(appearance?.theme, themeStore.listThemes());
	const mode: AppearanceMode = appearance?.mode ?? FACTORY_SETTINGS.appearance.mode;
	const renderedMode = resolveRenderedMode(mode, true); // server default: dark
	return {
		appearance,
		theme,
		mode,
		renderedMode,
		vars: themeVars(effectiveColors(theme, appearance), renderedMode),
	};
}
