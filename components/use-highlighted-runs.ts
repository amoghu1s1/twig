"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { carryRuns, highlightCode, type Run } from "@/components/code-highlight";
import type { CodeLanguage } from "@/src/core";

/**
 * The colored Runs for `source` in `language`. Always spells exactly
 * `source`: until its highlight arrives (the highlighter loads lazily and
 * answers off the render) it carries the previous colors across the edit
 * instead of dropping to plain. Server render and first paint are plain.
 */
export function useHighlightedRuns(source: string, language: CodeLanguage): readonly Run[] {
	const [latest, setLatest] = useState<{ source: string; language: CodeLanguage; runs: readonly Run[] }>({
		source: "",
		language,
		runs: [],
	});
	const current = useRef({ source, language });
	useEffect(() => {
		current.current = { source, language };
		const hit = highlightCode(source, language, (runs) => {
			if (current.current.source === source && current.current.language === language) setLatest({ source, language, runs });
		});
		if (hit) setLatest({ source, language, runs: hit });
	}, [source, language]);
	return useMemo(
		() => (latest.source === source && latest.language === language ? latest.runs : carryRuns(latest.runs, source)),
		[latest, source, language],
	);
}
