"use client";

/**
 * The notes editor (notes wave): a dependency-free prose textarea bound to
 * the NotesController. Markdown + $…$ math render when the chat renders
 * them — the field is the source (the Markdown-light convention: quotes
 * (`> `) are the tutor's words, one line each). The port keeps reset and
 * append server-driven edits out of the history-degrading onChange path.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { appendBlockText, type NotesController, type NotesEditorPort } from "@/components/notes-state";

export function NotesEditor({
	controller,
	hidden = false,
	textareaRef,
}: {
	controller: NotesController;
	hidden?: boolean;
	textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const hiddenRef = useRef(hidden);
	hiddenRef.current = hidden;
	const [text, setText] = useState(() => controller.text());

	const setAreaRef = useCallback((node: HTMLTextAreaElement | null) => {
		areaRef.current = node;
		if (textareaRef) textareaRef.current = node;
	}, [textareaRef]);

	useEffect(() => {
		setText(controller.text());
		const area = areaRef.current;
		if (!area) return;
		const port: NotesEditorPort = {
			// A fully controlled controlled-node seam: React applies the value,
			// the caret moves to the end only when the text is replaced whole.
			reset: (next) => {
				setText(next);
				area.scrollTop = area.scrollHeight;
			},
			append: (block) => {
				const value = appendBlockText(controller.text(), block);
				setText(value);
				area.scrollTop = area.scrollHeight;
				if (!hiddenRef.current) {
					area.focus({ preventScroll: true });
					const end = value.length;
					area.setSelectionRange?.(end, end);
				}
				controller.onEdit(value);
			},
		};
		controller.attach(port);
		return () => {
			controller.attach(null);
		};
	}, [controller]);

	return (
		<div ref={hostRef} className={hidden ? "hidden" : "min-h-0 flex-1 pb-2 pl-3"}>
			<textarea
				ref={setAreaRef}
				data-testid="notes-editor"
				aria-label="Session notes"
				placeholder="Jot down keywords, formulas, quotes…"
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					controller.onEdit(e.target.value);
				}}
				onKeyDown={(e) => {
					// Keep bare keys, Enter, Esc, and Tab isolated to the notes textarea
					// while allowing Mod/Alt global shortcuts (Alt+N, Alt+R, Mod+P) to bubble.
					if (!(e.metaKey || e.ctrlKey || e.altKey)) e.stopPropagation();
				}}
				className="h-full min-h-24 w-full resize-none bg-transparent font-prose text-sm leading-normal outline-none placeholder:text-muted-foreground"
			/>
		</div>
	);
}
