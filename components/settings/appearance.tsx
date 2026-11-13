"use client";
/**
 * THE ONE APPEARANCE APPLICATION (thin settings wave, 2026-09-19; theme wave,
 * 2026-11-04; light/system wave, 2026-10-29): the settings record's
 * appearance section — the DISPLAY MODE (dark | light | system, OS-follow),
 * the active THEME (a 12-color palette), the color overrides and the type
 * knobs — applied as RUNTIME CSS variables on <html> plus the `dark`/`light`
 * class. There is deliberately ONE provider: the theme catalog and the
 * light/system mode are two aspects of a single appearance system, not two
 * competing providers.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--background, --font-prose, --lh-ink-strong, …), so
 * application is setProperty and nothing re-renders. The ONE thing the
 * variables can't reach — the mode — is a class on <html>: app/layout.tsx
 * server-renders it (plus the theme's color vars and data-lh-mode) from the
 * record, an inline <head> script resolves System against the OS before the
 * first paint, and this provider owns every live switch after that (a
 * settings write, an OS flip under System, a theme import).
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider),
 * seeded with the record's appearance slice and resolved theme the layout
 * already read — no client fetch, so the first render carries the stored
 * mode/theme/background. (The open-settings chord lives in
 * components/keyboard-shortcuts.tsx.)
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	BUILTIN_THEMES,
	effectiveColors,
	FACTORY_SETTINGS,
	resolveRenderedMode,
	resolveTheme,
	themeVars,
	type AppearanceMode,
	type AppearanceSettings,
	type RenderedMode,
	type Theme,
	type ThemeColors,
} from "@/src/core";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		theme: delta?.theme ?? f.theme,
		background: delta?.background ?? f.background,
		colors: delta?.colors ?? f.colors,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		codeLigatures: delta?.codeLigatures ?? f.codeLigatures,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** Reading fonts the app ships itself (next/font in app/layout.tsx), by
 *  family name → the CSS variable carrying the bundled face. They work
 *  without being installed: an installed copy wins by name, the bundled
 *  one fills in otherwise. Exported for the font menu and tests. */
export const BUNDLED_READING_FONTS: Readonly<Record<string, string>> = {
	"JetBrains Mono": "var(--font-jetbrains)",
};

/** THE mapping: resolved appearance + active theme + rendered variant → the
 *  CSS variables to set on <html>. Colors: the theme with every override
 *  applied (core/themes.ts effectiveColors → themeVars); `mode` is the
 *  RENDERED variant (dark/light) and picks the hover-surface direction.
 *  Type knobs: absent entries leave the stylesheet value in place. Pure —
 *  exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	theme: Theme,
	mode: RenderedMode = theme.mode,
): Record<string, string> {
	const vars: Record<string, string> = themeVars(effectiveColors(theme, a), mode);
	if (a.fontFamily !== null) {
		const bundled = BUNDLED_READING_FONTS[a.fontFamily];
		vars["--font-prose"] = `"${a.fontFamily}", ${bundled ? `${bundled}, ` : ""}var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Code surfaces opt in to this token; never change prose or UI shaping.
	// "normal" permits the font's behavior rather than forcing glyph joining.
	vars["--lh-code-ligatures"] = a.codeLigatures ? "normal" : "none";
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown heading weight (the emphasis inks ride the theme colors).
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance (the record's delta over the factory). */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The raw record delta — what a section write composes onto. */
	delta: AppearanceSettings | undefined;
	/** The stored display mode (dark | light | system). */
	mode: AppearanceMode;
	/** The variant actually on screen — System resolved against the OS. */
	resolvedMode: RenderedMode;
	/** The active theme (Default when the record's id is gone). */
	activeTheme: Theme;
	/** The active theme with every override applied — what is on screen. */
	colors: ThemeColors;
	/** Presets, then imported customs. */
	themes: Theme[];
	/** Re-read the catalog after an import or a removal. */
	refreshThemes: () => Promise<void>;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const DEFAULT_CONTEXT_THEME = resolveTheme(undefined);

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	delta: undefined,
	mode: "dark",
	resolvedMode: DEFAULT_CONTEXT_THEME.mode,
	activeTheme: DEFAULT_CONTEXT_THEME,
	colors: DEFAULT_CONTEXT_THEME.colors,
	themes: [...BUILTIN_THEMES],
	refreshThemes: async () => {},
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function prefersDarkQuery(): MediaQueryList | null {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
	return window.matchMedia(DARK_QUERY);
}

function subscribePrefersDark(onChange: () => void): () => void {
	const mq = prefersDarkQuery();
	if (!mq) return () => {};
	mq.addEventListener("change", onChange);
	return () => mq.removeEventListener("change", onChange);
}

/** The OS preference as an external store: the server snapshot is dark (the
 *  layout's default), so hydration matches the server HTML and React
 *  re-renders with the real value right after — no mismatch under System. */
function usePrefersDark(): boolean {
	return useSyncExternalStore(subscribePrefersDark, () => prefersDarkQuery()?.matches ?? true, () => true);
}

export function AppearanceProvider({
	children,
	initialAppearance,
	initialTheme,
}: {
	children: React.ReactNode;
	/** The record's appearance delta, read server-side by the layout. */
	initialAppearance: AppearanceSettings | undefined;
	/** The active theme the layout resolved (a custom one included). */
	initialTheme: Theme;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(initialAppearance);
	const [themes, setThemes] = useState<Theme[]>(() =>
		initialTheme.builtin ? [...BUILTIN_THEMES] : [...BUILTIN_THEMES, initialTheme],
	);
	const appliedRef = useRef<string>("");
	const prefersDark = usePrefersDark();
	const appearance = useMemo(() => resolveAppearance(delta), [delta]);
	const { mode } = appearance;
	const resolvedMode = resolveRenderedMode(mode, prefersDark);
	const activeTheme = useMemo(
		() => resolveTheme(appearance.theme, themes.filter((t) => !t.builtin)),
		[appearance.theme, themes],
	);
	const colors = useMemo(() => effectiveColors(activeTheme, appearance), [activeTheme, appearance]);
	// The mode the layout rendered into data-lh-mode. A string, so it only
	// changes when the server's render does.
	const serverMode = resolveAppearance(initialAppearance).mode;

	// The class on <html> drives every `.dark`/`.light` rule and variant.
	// System reads the OS here, not resolvedMode: during hydration that still
	// holds the server snapshot (dark) and would undo the head script's class
	// for a commit. resolvedMode stays a dep so an OS flip re-runs this, and
	// serverMode so a server re-render of the layout (HMR, a refresh) that
	// rewrites className is corrected in the same commit. A LAYOUT effect
	// (like the vars below): descendants' passive effects run after it, so
	// anything reading computed tokens (the graph canvas) sees the new mode,
	// and the swap lands before paint.
	useLayoutEffect(() => {
		const root = document.documentElement;
		const dark = mode === "system" ? (prefersDarkQuery()?.matches ?? true) : mode === "dark";
		root.classList.toggle("dark", dark);
		root.classList.toggle("light", !dark);
	}, [mode, resolvedMode, serverMode, initialTheme]);

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(appearance, activeTheme, resolvedMode), [appearance, activeTheme, resolvedMode]);
	// A refreshed server layout can rewrite <html>'s class/style while the
	// mounted provider retains a newer local save. Reapply that live state
	// when the server-rendered palette changes, even within the same mode.
	const serverKey = JSON.stringify(themeVars(effectiveColors(initialTheme, initialAppearance), resolveRenderedMode(serverMode, prefersDark)));
	const key = useMemo(() => JSON.stringify([vars, serverKey]), [vars, serverKey]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty font = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever. Every
	// name this effect has ever set is tracked; names absent from the new
	// set are removed so the stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useLayoutEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// The desktop shell's native chrome (window background, Windows/Linux
	// control overlay) follows the MODE and effective background — absent in
	// a browser. `mode` is the raw stored value (dark | light | system) so
	// Electron's nativeTheme can follow the OS under System.
	const background = colors.background;
	useEffect(() => {
		window.lh?.setAppearance?.({ mode, background });
	}, [mode, background]);

	const refreshThemes = useCallback(async () => {
		try {
			const res = await fetch("/api/themes");
			if (!res.ok) return;
			const body = (await res.json()) as { themes?: Theme[] };
			if (Array.isArray(body.themes)) setThemes(body.themes);
		} catch {
			/* the presets stay — not worth a crash */
		}
	}, []);

	// One catalog read per app load (the imported customs).
	useEffect(() => {
		void refreshThemes();
	}, [refreshThemes]);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		// There is no startup settings GET to race this save: the layout
		// seeds the record synchronously into the provider's initial state.
		setDelta(next);
	}, []);

	const value = useMemo(
		() => ({ appearance, delta, mode, resolvedMode, activeTheme, colors, themes, refreshThemes, onAppearanceChange }),
		[appearance, delta, mode, resolvedMode, activeTheme, colors, themes, refreshThemes, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
