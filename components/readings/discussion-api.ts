"use client";

/**
 * Discuss on a reading — the client seam (docs/readings.md §14): ask /
 * stop helpers + push-driven hooks. The record is truth (refetched on the
 * events channel's discussion-changed poke); a live answer's tokens ride
 * their own SSE stream until it settles.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscussionAsk, DiscussionExchange, DiscussionThread, ReadingDiscussionRecord } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";

export type ExchangeView = DiscussionExchange & { costUsd: number | null };
export type ThreadView = Omit<DiscussionThread, "exchanges"> & { exchanges: ExchangeView[] };
export type DiscussionView = Omit<ReadingDiscussionRecord, "side" | "threads"> & { side: ThreadView; threads: ThreadView[] };

/** POST an ask → the thread + exchange ids, or the server's refusal text. */
export async function askQuestion(
	readingId: string,
	ask: DiscussionAsk,
): Promise<{ ok: true; threadId: string; exchangeId: string } | { ok: false; error: string }> {
	try {
		const res = await fetch(`/api/readings/${readingId}/discussion`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(ask),
		});
		const data = (await res.json().catch(() => ({}))) as { threadId?: string; exchangeId?: string; error?: string };
		if (res.ok && data.threadId && data.exchangeId) return { ok: true, threadId: data.threadId, exchangeId: data.exchangeId };
		return { ok: false, error: data.error ?? `The server refused (${res.status})` };
	} catch {
		return { ok: false, error: "The app server didn't answer" };
	}
}

/** Stop a live answer (the dock's END path). */
export async function stopAnswer(exchangeId: string): Promise<void> {
	await fetch("/api/activity/abort", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ kind: "discussion", id: exchangeId }),
	}).catch(() => undefined);
}

/** The reading's discussion; null while loading (or unreachable). */
export function useDiscussion(readingId: string | null): DiscussionView | null {
	const [discussion, setDiscussion] = useState<DiscussionView | null>(null);
	const seq = useRef(0);
	const refresh = useCallback(() => {
		if (!readingId) return;
		const mine = ++seq.current; // a newer request wins; older replies drop
		void fetch(`/api/readings/${readingId}/discussion`)
			.then((r) => (r.ok ? (r.json() as Promise<DiscussionView>) : null))
			.then((d) => {
				if (mine === seq.current && d) setDiscussion(d);
			})
			.catch(() => undefined);
	}, [readingId]);
	useEffect(() => {
		setDiscussion(null);
		refresh();
	}, [refresh]);
	// Pokes come in bursts (per-step usage writes): one trailing fetch.
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useServerEvent("discussion-changed", ({ readingId: changed }) => {
		if (changed !== readingId) return;
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(refresh, 150);
	});
	useServerResync(refresh);
	useEffect(() => () => timer.current && clearTimeout(timer.current), []);
	return discussion;
}

export interface LiveAnswer {
	text: string;
	activity: string;
}

/** A live answer's tokens while `active` (the exchange is queued or
 *  answering); null when nothing has streamed. Closes on settle — the
 *  record refetch then carries the final answer. */
export function useLiveAnswer(readingId: string, exchangeId: string, active: boolean): LiveAnswer | null {
	const [live, setLive] = useState<LiveAnswer | null>(null);
	useEffect(() => {
		if (!active) {
			setLive(null);
			return;
		}
		const source = new EventSource(`/api/readings/${readingId}/discussion/stream?exchange=${encodeURIComponent(exchangeId)}`);
		source.onmessage = (e) => {
			let frame: { type?: string; text?: string; activity?: string };
			try {
				frame = JSON.parse(e.data as string) as typeof frame;
			} catch {
				return;
			}
			if (frame.type === "view") setLive({ text: frame.text ?? "", activity: frame.activity ?? "" });
			else if (frame.type === "settled") source.close();
		};
		// A dropped stream retries by itself (EventSource); a settled one
		// was closed above, so no reconnect loop.
		return () => source.close();
	}, [readingId, exchangeId, active]);
	return live;
}
