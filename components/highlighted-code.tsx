"use client";

import type { CSSProperties } from "react";
import { useHighlightedRuns } from "@/components/use-highlighted-runs";
import type { CodeLanguage } from "@/src/core";

/**
 * Source as colored text — the inside of a <pre>, not the <pre> itself, so
 * the editor's overlay and the answered card each keep their own box. Colors
 * follow the app theme through .lh-tok (globals.css).
 */
export function HighlightedCode({ code, language }: { code: string; language: CodeLanguage }) {
	const runs = useHighlightedRuns(code, language);
	return (
		<>
			{runs.map((run, index) =>
				run.light === undefined ? (
					run.text
				) : (
					<span key={index} className="lh-tok" style={{ "--tok-light": run.light, "--tok-dark": run.dark } as CSSProperties}>
						{run.text}
					</span>
				),
			)}
		</>
	);
}
