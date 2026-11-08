"use client";

/**
 * NOTES — the browser state (notes wave). One external store per chat
 * view: debounced saves into PUT /api/chats/:id/notes, a flush on
 * `pagehide`, and the stale-write guard — every save carries the
 * fingerprint of the text the view last SAW, so work edited in another
 * window is never silently dropped (409 → warn, re-read, next save wins).
 *
 * The editor attaches through a small port (reset/replace semantics), so
 * `refresh` can adopt server truth between saves; local edits always win
 * while the view is dirty.
 */

import { clampNotesWidth, NOTES_AUTOFOLD_BELOW, NOTES_DEFAULT_WIDTH, NOTES_WIDTH_KEY } from "@/components/notes-layout";
import { notesFingerprint } from "@/src/core";
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";

export const NOTES_OPEN_KEY = "lh-notes-open";
const SAVE_ERROR = "Notes not saved";
const STALE_ERROR = "Notes changed in another view — your next save keeps your edits";
// Browsers refuse keepalive bodies over 64 KiB.
const KEEPALIVE_MAX_BYTES = 60_000;

export interface NotesEditorPort {
	/** Replace the whole document (server truth adopted; never an edit). */
	reset(text: string): void;
	/** Append one block (a tutor quote) without disturbing the caret more
	 *  than a scroll-to-end; the caller has already validated non-blank. */
	append(block: string): void;
}

export interface NotesSnapshot {
	open: boolean;
	width: number;
	/** `open`, unless auto-folded for a narrow window. */
	visible: boolean;
	saveError: string | null;
}

type NotesStorage = Pick<Storage, "getItem" | "setItem">;

const CLOSED: NotesSnapshot = { open: false, width: NOTES_DEFAULT_WIDTH, visible: false, saveError: null };

export class NotesController {
	private current: string;
	private version = 0;
	private savedVersion = 0;
	private snapshot: NotesSnapshot;
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inflight: Promise<boolean> | null = null;
	private port: NotesEditorPort | null = null;
	private narrow = false;
	private openedWhileNarrow = false;
	/** The fingerprint of the text this view last saw from the server (or
	 *  last saved) — the next save's `base`. */
	private base: string;
	private readonly delay: number;
	private readonly storage: NotesStorage | undefined;

	constructor(
		private readonly chatId: string,
		initialText: string,
		opts: { saveDelayMs?: number; storage?: NotesStorage } = {},
	) {
		this.current = initialText;
		this.base = notesFingerprint(initialText);
		this.delay = opts.saveDelayMs ?? 600;
		this.storage = opts.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
		let open = false;
		try {
			open = this.storage?.getItem(NOTES_OPEN_KEY) === "1";
		} catch {}
		let width = NOTES_DEFAULT_WIDTH;
		try {
			const raw = this.storage?.getItem(NOTES_WIDTH_KEY);
			if (raw != null) width = clampNotesWidth(Number(raw));
		} catch {}
		this.snapshot = { open, width, visible: open, saveError: null };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	getSnapshot(): NotesSnapshot {
		return this.snapshot;
	}

	text(): string {
		return this.current;
	}

	setOpen(open: boolean): void {
		if (open && this.narrow) this.openedWhileNarrow = true;
		if (!open) this.openedWhileNarrow = false;
		if (open !== this.snapshot.open) {
			try {
				this.storage?.setItem(NOTES_OPEN_KEY, open ? "1" : "0");
			} catch {}
		}
		this.update({ open });
	}

	setWidth(px: number): void {
		const width = clampNotesWidth(px);
		try {
			this.storage?.setItem(NOTES_WIDTH_KEY, String(width));
		} catch {}
		this.update({ width });
	}

	setNarrow(narrow: boolean): void {
		if (narrow === this.narrow) return;
		if (narrow) this.openedWhileNarrow = false;
		this.narrow = narrow;
		this.update({});
	}

	attach(port: NotesEditorPort | null): void {
		this.port = port;
	}

	onEdit(text: string): void {
		if (text === this.current) return;
		this.current = text;
		this.version++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), this.delay);
	}

	/** Append a tutor quote to the notes and open the panel. The editor,
	 *  when attached, carries the block in as one append so the caret and
	 *  undo stay usable; a folded panel edits straight into the text. */
	appendQuote(quote: string): void {
		if (!quote.trim()) return;
		const block = quoteAsMarkdown(quote);
		this.setOpen(true);
		if (this.port) this.port.append(block);
		else this.onEdit(appendBlockText(this.current, block));
	}

	/** Re-read the saved text (Back/Forward can mount stale props); local
	 *  edits always win. */
	async refresh(): Promise<void> {
		const version = this.version;
		if (this.dirty()) return;
		let text: unknown;
		try {
			const res = await fetch(`/api/chats/${this.chatId}/notes`, { cache: "no-store" });
			if (!res.ok) return;
			text = ((await res.json()) as { text?: unknown }).text;
		} catch {
			return;
		}
		if (typeof text !== "string" || this.dirty() || this.version !== version || text === this.current) return;
		this.current = text;
		this.base = notesFingerprint(text);
		this.port?.reset(text);
	}

	flush(opts: { keepalive?: boolean } = {}): Promise<boolean> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.inflight) return this.inflight.then(() => this.flush(opts));
		if (this.version === this.savedVersion) return Promise.resolve(true);
		return this.save(!!opts.keepalive);
	}

	dispose(): void {
		void this.flush({ keepalive: true });
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.port = null;
	}

	private dirty(): boolean {
		return this.version !== this.savedVersion || this.inflight !== null;
	}

	private save(keepalive: boolean): Promise<boolean> {
		const version = this.version;
		const body = JSON.stringify({ text: this.current, base: this.base });
		let request: Promise<Response>;
		try {
			request = fetch(`/api/chats/${this.chatId}/notes`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body,
				keepalive: keepalive && new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES,
			});
		} catch (err) {
			request = Promise.reject(err);
		}
		const run: Promise<boolean> = request.then(
			async (res) => {
				if (!res.ok) {
					if (res.status === 409) {
						// Another view saved in between: adopt its fingerprint so the
						// user's NEXT save (their newer edits) lands cleanly, and say so.
						const body = await res.json().catch(() => null) as { text?: unknown } | null;
						if (typeof body?.text === "string") this.base = notesFingerprint(body.text);
						return { ok: false, stale: true };
					}
					return { ok: false, stale: false };
				}
				return { ok: true, stale: false };
			},
			() => ({ ok: false, stale: false }),
		).then((outcome) => {
			if (this.inflight === run) this.inflight = null;
			if (outcome.ok) {
				this.savedVersion = version;
				this.base = notesFingerprint(this.current);
			}
			this.update({ saveError: outcome.ok ? null : outcome.stale ? STALE_ERROR : SAVE_ERROR });
			return outcome.ok;
		});
		this.inflight = run;
		return run;
	}

	private update(patch: Partial<NotesSnapshot>): void {
		const next = { ...this.snapshot, ...patch };
		next.visible = next.open && (!this.narrow || this.openedWhileNarrow);
		const prev = this.snapshot;
		if (next.open === prev.open && next.width === prev.width && next.visible === prev.visible && next.saveError === prev.saveError) return;
		this.snapshot = next;
		for (const l of [...this.listeners]) l();
	}
}

// ─── tutor quotes (the `>` = the tutor's words convention) ─────────────────

/** Format selected tutor text as a Markdown blockquote. */
export function quoteAsMarkdown(quote: string): string {
	return quote
		.trim()
		.split("\n")
		.map((line) => (line.trim() ? `> ${line}` : ">"))
		.join("\n");
}

/** One blank-line-separated block append (existing content survives). */
export function appendBlockText(notes: string, block: string): string {
	return notes.trim() ? `${notes.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

const NotesContext = createContext<NotesController | null>(null);

export function NotesProvider({ controller, children }: { controller: NotesController; children: ReactNode }) {
	useEffect(() => {
		if (typeof window === "undefined") return;
		void controller.refresh();
		const onResize = () => controller.setNarrow(window.innerWidth < NOTES_AUTOFOLD_BELOW);
		onResize();
		window.addEventListener("resize", onResize);
		const onHide = () => void controller.flush({ keepalive: true });
		window.addEventListener("pagehide", onHide);
		return () => {
			window.removeEventListener("pagehide", onHide);
			window.removeEventListener("resize", onResize);
			controller.dispose();
		};
	}, [controller]);
	return <NotesContext.Provider value={controller}>{children}</NotesContext.Provider>;
}

export function useNotesController(): NotesController | null {
	return useContext(NotesContext);
}

const noSubscribe = () => () => {};

export function useNotesSnapshot(): NotesSnapshot {
	const c = useNotesController();
	return useSyncExternalStore(
		c ? (cb) => c.subscribe(cb) : noSubscribe,
		() => (c ? c.getSnapshot() : CLOSED),
		// In the browser, hydrate as the server rendered (it reads no storage).
		() => (c && typeof window === "undefined" ? c.getSnapshot() : CLOSED),
	);
}
