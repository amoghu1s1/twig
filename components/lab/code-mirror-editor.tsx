"use client";

import { useEffect, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import type { LabLanguage } from "@/src/core";

const twigEditorTheme = EditorView.theme({
	"&": {
		backgroundColor: "transparent",
		color: "var(--foreground)",
		fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
		fontSize: "0.875rem",
		lineHeight: "1.6",
	},
	"&.cm-focused": {
		outline: "none",
	},
	".cm-scroller": {
		fontFamily: "inherit",
		overflowX: "auto",
	},
	".cm-content": {
		padding: "10px 12px",
		caretColor: "var(--foreground)",
	},
	".cm-line": {
		padding: "0",
	},
	".cm-cursor, .cm-dropCursor": {
		borderLeftColor: "var(--foreground)",
		borderLeftWidth: "1.5px",
	},
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "color-mix(in srgb, var(--lh-ink-italic, #b4c6ef) 24%, transparent)",
	},
	".cm-activeLine": {
		backgroundColor: "transparent",
	},
	".cm-matchingBracket": {
		backgroundColor: "color-mix(in srgb, var(--lh-ink-code, #e7c787) 18%, transparent)",
		color: "var(--lh-ink-code, #e7c787)",
		outline: "none",
	},
	".cm-placeholder": {
		color: "var(--muted-foreground)",
		opacity: "0.65",
	},
});

const twigHighlightStyle = HighlightStyle.define([
	{ tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.moduleKeyword], color: "var(--lh-ink-italic, #b4c6ef)" },
	{ tag: [tags.string, tags.special(tags.string)], color: "var(--lh-ink-code, #e7c787)" },
	{ tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--lh-ink-code, #e7c787)" },
	{ tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
	{ tag: [tags.function(tags.variableName), tags.definition(tags.function(tags.variableName))], color: "var(--lh-ink-strong, var(--foreground))" },
	{ tag: [tags.className, tags.typeName], color: "var(--lh-ink-italic, #b4c6ef)" },
	{ tag: [tags.operator, tags.punctuation], color: "var(--muted-foreground)" },
]);

export interface CodeMirrorEditorProps {
	value: string;
	language?: LabLanguage | "plain";
	placeholder?: string;
	readOnly?: boolean;
	minHeightClassName?: string;
	ariaLabel?: string;
	onChange: (next: string) => void;
	onRunAndAdvance?: () => void;
	onRunInPlace?: () => void;
	onSave?: () => void;
	onFocus?: () => void;
}

export function CodeMirrorEditor({
	value,
	language = "python",
	placeholder,
	readOnly = false,
	minHeightClassName = "min-h-12",
	ariaLabel,
	onChange,
	onRunAndAdvance,
	onRunInPlace,
	onSave,
	onFocus,
}: CodeMirrorEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const [mounted, setMounted] = useState(false);

	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onRunAdvanceRef = useRef(onRunAndAdvance);
	onRunAdvanceRef.current = onRunAndAdvance;
	const onRunInPlaceRef = useRef(onRunInPlace);
	onRunInPlaceRef.current = onRunInPlace;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const onFocusRef = useRef(onFocus);
	onFocusRef.current = onFocus;
	const latestValueRef = useRef(value);
	latestValueRef.current = value;

	useEffect(() => {
		const container = hostRef.current;
		if (!container) return;

		const runKeys = Prec.highest(
			keymap.of([
				{
					key: "Shift-Enter",
					run: () => {
						if (!onRunAdvanceRef.current) return false;
						onRunAdvanceRef.current();
						return true;
					},
				},
				{
					key: "Mod-Enter",
					run: () => {
						if (!onRunInPlaceRef.current) return false;
						onRunInPlaceRef.current();
						return true;
					},
				},
				{
					key: "Mod-s",
					run: () => {
						if (!onSaveRef.current) return false;
						onSaveRef.current();
						return true;
					},
				},
				{
					key: "Escape",
					run: (view) => {
						view.contentDOM.blur();
						return true;
					},
				},
			]),
		);

		const state = EditorState.create({
			doc: latestValueRef.current,
			extensions: [
				runKeys,
				history(),
				drawSelection(),
				EditorView.lineWrapping,
				indentUnit.of("    "),
				bracketMatching(),
				closeBrackets(),
				syntaxHighlighting(twigHighlightStyle),
				twigEditorTheme,
				language === "python" ? python() : [],
				placeholder ? cmPlaceholder(placeholder) : [],
				EditorState.readOnly.of(readOnly),
				EditorView.editable.of(!readOnly),
				ariaLabel ? EditorView.contentAttributes.of({ "aria-label": ariaLabel }) : [],
				keymap.of([
					{ key: "Mod-/", run: toggleComment },
					indentWithTab,
					...closeBracketsKeymap,
					...defaultKeymap,
					...historyKeymap,
				]),
				EditorView.updateListener.of((update) => {
					if (update.focusChanged && update.view.hasFocus) {
						onFocusRef.current?.();
					}
					if (update.docChanged) {
						const next = update.state.doc.toString();
						latestValueRef.current = next;
						onChangeRef.current(next);
					}
				}),
			],
		});

		const view = new EditorView({ state, parent: container });
		viewRef.current = view;
		setMounted(true);

		return () => {
			view.destroy();
			viewRef.current = null;
			setMounted(false);
		};
	}, [language, readOnly, placeholder, ariaLabel]);

	// Sync external code changes (mentor updates / reloads) without disrupting active typing.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current !== value) {
			view.dispatch({
				changes: { from: 0, to: current.length, insert: value },
			});
		}
	}, [value]);

	return (
		<div
			className={`relative w-full ${minHeightClassName}`}
			data-testid="lab-codemirror"
		>
			{!mounted && (
				<pre className="m-0 whitespace-pre-wrap px-3 py-2.5 font-mono text-sm leading-[1.6] text-foreground/90">
					{value || placeholder || " "}
				</pre>
			)}
			<div ref={hostRef} className="w-full" />
		</div>
	);
}
