"use client";

/**
 * Readings — the client seam (docs/readings.md): request/list/fetch
 * helpers + push-driven hooks. Truth lives on the server; the events
 * channel's readings-changed poke triggers a refetch (notify → fetch).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReadingMode, ReadingProposition, ReadingRecord, ReadingRequest, ReadingSummary } from "@/src/core";
import { DEFAULT_READING_MODE } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";

export type FullReading = ReadingRecord & { costUsd: number | null; practice: ReadingProposition[]; chatTitle?: string };

/** POST /api/readings → the new id, or the server's refusal text. */
export async function requestReading(req: ReadingRequest): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	try {
		const res = await fetch("/api/readings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(req),
		});
		const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
		if (res.ok && data.id) return { ok: true, id: data.id };
		return { ok: false, error: data.error ?? `Request failed (${res.status})` };
	} catch {
		return { ok: false, error: "Couldn't reach the app server" };
	}
}

export async function deleteReadingRequest(id: string): Promise<boolean> {
	try {
		const res = await fetch(`/api/readings/${id}`, { method: "DELETE" });
		return res.ok;
	} catch {
		return false;
	}
}

export async function stopReading(id: string): Promise<void> {
	await fetch("/api/activity/abort", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ kind: "reading", id }),
	}).catch(() => undefined);
}

/** Start a practice session on a reading's propositions (the existing
 *  practice entry: graph-context picks ride the creation). Returns the
 *  push target, or null on failure. */
export async function startPractice(title: string, picks: ReadingProposition[]): Promise<string | null> {
	if (picks.length === 0) return null;
	const prompt = `Practice what “${title}” covers.`;
	try {
		const res = await fetch("/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: `Practice: ${title}`,
				kind: "practice",
				graphContext: { propositions: picks.map((p) => ({ id: p.id, name: p.name, statement: p.statement })) },
			}),
		});
		const { id } = (await res.json()) as { id?: string };
		return id ? `/chat/${id}?prompt=${encodeURIComponent(prompt)}` : null;
	} catch {
		return null;
	}
}

/** Refetch on every readings poke (debounced) and on channel resync. */
function useReadingsPoke(cb: () => void): void {
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useServerEvent("readings-changed", () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => cbRef.current(), 200);
	});
	useServerResync(() => cbRef.current());
	useEffect(() => () => timer.current && clearTimeout(timer.current), []);
}

/** The list view (optionally scoped to a session or a graph node). */
export function useReadings(filter: { chatId?: string; nodeId?: string } | null): {
	readings: ReadingSummary[] | null;
	refresh: () => void;
} {
	const [readings, setReadings] = useState<ReadingSummary[] | null>(null);
	const key = filter === null ? null : `${filter.chatId ?? ""}|${filter.nodeId ?? ""}`;
	const seq = useRef(0);
	const refresh = useCallback(() => {
		if (key === null) return;
		const mine = ++seq.current; // a newer request wins; older replies drop
		const [chatId, nodeId] = key.split("|");
		const qs = new URLSearchParams();
		if (chatId) qs.set("chatId", chatId);
		if (nodeId) qs.set("nodeId", nodeId);
		void fetch(`/api/readings${qs.size > 0 ? `?${qs}` : ""}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d: { readings?: ReadingSummary[] } | null) => {
				if (mine === seq.current && d?.readings) setReadings(d.readings);
			})
			.catch(() => undefined);
	}, [key]);
	useEffect(() => {
		setReadings(null);
		refresh();
	}, [refresh]);
	useReadingsPoke(refresh);
	return { readings, refresh };
}

/** One reading in full; null while loading, "missing" when gone, "error"
 *  when the server can't be reached (the view says so — never spins). */
export function useReading(id: string | null): FullReading | null | "missing" | "error" {
	const [reading, setReading] = useState<FullReading | null | "missing" | "error">(null);
	const seq = useRef(0);
	const refresh = useCallback(() => {
		if (!id) return;
		const mine = ++seq.current;
		const land = (v: FullReading | "missing" | "error") => {
			if (mine === seq.current) setReading((prev) => (v === "error" && prev && typeof prev === "object" ? prev : v));
		};
		void fetch(`/api/readings/${id}`)
			.then(async (r) => {
				if (r.status === 404) return land("missing");
				if (!r.ok) return land("error");
				land((await r.json()) as FullReading);
			})
			.catch(() => land("error"));
	}, [id]);
	useEffect(() => {
		setReading(null);
		refresh();
	}, [refresh]);
	useReadingsPoke(refresh);
	return reading;
}

// ─── the session's readings seam (provided by the chat page) ────────────────

export interface SessionReadings {
	chatId: string;
	/** Open the tray (optionally on one reading). */
	open: (readingId?: string) => void;
	/** Create a session-anchored reading and open it in the tray. Resolves
	 *  to the error text on refusal, null on success. */
	request: (req: Omit<ReadingRequest, "chatId">) => Promise<string | null>;
	/** The session's readings (for the offer cards' "already written"). */
	readings: ReadingSummary[];
	/** The learner's current source-mode choice (shared across entry points). */
	mode: ReadingMode;
	setMode: (m: ReadingMode) => void;
}

export const SessionReadingsContext = createContext<SessionReadings | null>(null);

export function useSessionReadings(): SessionReadings | null {
	return useContext(SessionReadingsContext);
}

const MODE_KEY = "lh:readings-mode";

/** The remembered source mode (a per-viewer convenience; default:
 *  researched — owner ruling 2026-10-27). */
export function useReadingMode(): [ReadingMode, (m: ReadingMode) => void] {
	const [mode, setModeState] = useState<ReadingMode>(DEFAULT_READING_MODE);
	useEffect(() => {
		try {
			const v = localStorage.getItem(MODE_KEY);
			if (v === "researched" || v === "model") setModeState(v);
		} catch {
			/* storage blocked — default stands */
		}
	}, []);
	const setMode = useCallback((m: ReadingMode) => {
		setModeState(m);
		try {
			localStorage.setItem(MODE_KEY, m);
		} catch {
			/* storage blocked — in-memory only */
		}
	}, []);
	return [mode, setMode];
}

/** "3 min ago" style relative time, compact. */
export function ago(iso: string, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.round(h / 24);
	return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}
