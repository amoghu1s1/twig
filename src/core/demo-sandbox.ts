/**
 * The generated-content sandbox policy (security hardening, ported from the
 * jacobderechin fork, 2026-11-08): LLM-written demos and figures are
 * self-contained documents and get NO network — not in the hidden verifier
 * (agent/subagents/headless.ts, which serves them at an opaque https origin
 * with this CSP as a header and aborts every other request), and not in the
 * learner's iframe (components/artifacts/demo-card.tsx,
 * sandbox="allow-scripts" + this CSP as a meta tag). Inline script/style and
 * data:/blob: media stay allowed: that is everything a single-file
 * Canvas/SVG demo needs.
 */
export const DEMO_CSP =
	"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; " +
	"img-src data: blob:; font-src data:; media-src data: blob:; worker-src blob:; " +
	"connect-src 'none'; form-action 'none'; base-uri 'none'";

/** The verifier's origin for generated documents — never file://. */
export const DEMO_SANDBOX_URL = "https://demo.invalid/";

/** Prepend the CSP meta so it governs the WHOLE document: right after a
 *  leading doctype (keeps standards mode), else at the very start. */
export function withDemoCsp(html: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}">`;
	const doctype = /^\s*(?:﻿)?<!doctype[^>]*>/i.exec(html);
	return doctype ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}` : `${meta}${html}`;
}
