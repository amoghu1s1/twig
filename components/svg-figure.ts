/**
 * ```svg FENCES: a figure the model drew by hand (a triangle, a unit circle,
 * vectors), shown as a real picture by md-blocks' SvgFigure. Like the
 * `visual` tool's figures it renders as an inert image document
 * (artifacts/svg-image.tsx): no scripts, no external loads, no HTML.
 *
 * An image can't inherit the page's colors, so the figure's root gets the
 * prose text color (the theme's ink) as its `color`: strokes and text drawn
 * in currentColor follow the theme. Unless the root sets its own fill, it
 * fills with the ink too, so text and shapes with no fill anywhere up their
 * tree take it instead of SVG's default black (invisible on a dark theme).
 */
import { useEffect, useState, type RefObject } from "react";

/** Bigger than any hand-drawn figure; past it the source shows as code. */
export const SVG_FIGURE_MAX_CHARS = 40_000;

/** Dark ink for the full-screen view, which shows figures on a white stage. */
export const FIGURE_STAGE_INK = "#1f2328";

/** Narrower than this, a viewBox is in math units (a unit circle's
 *  "-1.2 -1.2 2.4 2.4"), not pixels: show it at FIGURE_DEFAULT_W instead. */
const MATH_UNITS_BELOW = 100;
const FIGURE_DEFAULT_W = 360;

/** The width (px) to show a figure at, from its natural width (1 viewBox
 *  unit = 1 px). Pure. */
export function figureDisplayWidth(naturalWidth: number): number {
	return naturalWidth < MATH_UNITS_BELOW ? FIGURE_DEFAULT_W : naturalWidth;
}

/** A color as getComputedStyle reports it (rgb(), oklch(), #hex …). Anything
 *  else could break out of the style element it's written into. */
const SAFE_INK = /^[#(),.%/\w\s-]+$/;

/** The figure ready for an <img>, or null when the source isn't one whole
 *  <svg> element or is too large. Pure. */
export function prepareSvgFigure(source: string, ink: string): string | null {
	if (source.length > SVG_FIGURE_MAX_CHARS) return null;
	// An XML prolog, doctype or comments around the element are harmless.
	const svg = source
		.replace(/^(?:<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|\s)+/i, "")
		.replace(/(?:<!--[\s\S]*?-->|\s)+$/, "");
	if (svg.length === 0) return null;
	const open = /^<svg\b[^>]*>/i.exec(svg);
	if (!open || open[0].endsWith("/>") || !/<\/svg>$/i.test(svg)) return null;
	// An image document needs the namespace to render at all.
	const tag = /\sxmlns\s*=/.test(open[0]) ? open[0] : open[0].replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
	const color = SAFE_INK.test(ink) ? ink : FIGURE_STAGE_INK;
	const style =
		`<style>svg{color:${color};font-family:ui-sans-serif,system-ui,sans-serif}` +
		`svg:not([fill]):not([style*="fill"]){fill:currentColor}</style>`;
	return tag + style + svg.slice(open[0].length);
}

/** The text color at `ref` (the theme's ink), re-read when the theme
 *  changes (the theme lives in <html>'s class). Null until mounted. */
export function useThemeInk(ref: RefObject<HTMLElement | null>): string | null {
	const [ink, setInk] = useState<string | null>(null);
	useEffect(() => {
		const read = () => {
			const el = ref.current;
			if (!el || typeof getComputedStyle !== "function") return;
			setInk(getComputedStyle(el).color || FIGURE_STAGE_INK);
		};
		read();
		if (typeof MutationObserver !== "function") return;
		const observer = new MutationObserver(read);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
		return () => observer.disconnect();
	}, [ref]);
	return ink;
}
