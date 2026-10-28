"use client";

/**
 * "READ DEEPER" ON A PASSAGE (docs/readings.md §6.1): select any stretch
 * of the teacher's prose and a small floating action offers a deep dive on
 * exactly that passage, anchored to its message. The selection is the
 * learner's own gesture; nothing happens until he clicks.
 *
 * Scope: teacher text parts only (`.is-assistant [data-source-message-id]`
 * inside the given root) — learner notes, cards, and chrome never offer it.
 */

import { useEffect, useState, type RefObject } from "react";
import { BookOpenIcon } from "lucide-react";
import { useSessionReadings } from "@/components/readings/api";

const MIN_CHARS = 12;
const MAX_CHARS = 4000;

interface Pick {
	text: string;
	messageId: string;
	x: number;
	y: number;
}

/** The passage a selection maps to, or null when it isn't a teacher
 *  passage inside `root`. Exported for tests. */
export function passageFromSelection(sel: Selection | null, root: HTMLElement | null): { text: string; messageId: string; rect: DOMRect } | null {
	if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) return null;
	const text = sel.toString().replace(/\s+/g, " ").trim();
	if (text.length < MIN_CHARS) return null;
	const range = sel.getRangeAt(0);
	const el = (n: Node | null) => (n instanceof Element ? n : n?.parentElement ?? null);
	const start = el(range.startContainer)?.closest<HTMLElement>("[data-source-message-id]");
	const end = el(range.endContainer)?.closest<HTMLElement>("[data-source-message-id]");
	if (!start || start !== end || !root.contains(start)) return null;
	if (!start.closest(".is-assistant")) return null;
	const messageId = start.dataset.sourceMessageId;
	if (!messageId) return null;
	return { text: text.slice(0, MAX_CHARS), messageId, rect: range.getBoundingClientRect() };
}

export function PassageReadDeeper({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
	const seam = useSessionReadings();
	const [pick, setPick] = useState<Pick | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!seam) return;
		const update = () => {
			const found = passageFromSelection(document.getSelection(), rootRef.current);
			if (!found) {
				setPick(null);
				setError(null);
				return;
			}
			setPick({
				text: found.text,
				messageId: found.messageId,
				x: Math.min(Math.max(found.rect.left + found.rect.width / 2, 80), window.innerWidth - 80),
				y: Math.max(found.rect.top - 8, 56),
			});
		};
		const onUp = () => setTimeout(update, 0);
		const onSelection = () => {
			if (document.getSelection()?.isCollapsed) setPick(null);
		};
		const onScroll = () => setPick(null);
		document.addEventListener("mouseup", onUp);
		document.addEventListener("keyup", onUp);
		document.addEventListener("selectionchange", onSelection);
		rootRef.current?.addEventListener("scroll", onScroll, true);
		const root = rootRef.current;
		return () => {
			document.removeEventListener("mouseup", onUp);
			document.removeEventListener("keyup", onUp);
			document.removeEventListener("selectionchange", onSelection);
			root?.removeEventListener("scroll", onScroll, true);
		};
	}, [seam, rootRef]);

	if (!seam || !pick) return null;
	return (
		<div
			data-testid="passage-read-deeper"
			className="fixed z-50 -translate-x-1/2 -translate-y-full"
			style={{ left: pick.x, top: pick.y }}
			// Keep the selection alive while clicking the action.
			onMouseDown={(e) => e.preventDefault()}
		>
			<div className="flex items-center gap-1 rounded-full border bg-card px-1 py-1 shadow-lg">
				<button
					type="button"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setError(null);
						const err = await seam.request({ kind: "deep-dive", passage: pick.text, messageId: pick.messageId });
						setBusy(false);
						if (err) return setError(err);
						document.getSelection()?.removeAllRanges();
						setPick(null);
					}}
					className="flex items-center gap-1.5 rounded-full px-2.5 py-1 font-ui text-xs font-medium hover:bg-accent disabled:opacity-60"
				>
					<BookOpenIcon className="size-3.5 text-primary" />
					Read deeper
				</button>
			</div>
			{error && <div className="mt-1 max-w-xs rounded-md bg-card px-2 py-1 font-ui text-xs text-destructive shadow">{error}</div>}
		</div>
	);
}
