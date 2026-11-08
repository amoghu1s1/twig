"use client";

import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { MistakeRecord } from "@/src/core";
import { useServerEvent } from "@/components/server-events";

/** The open session's recorded mistakes, keyed by `<chatId>:<toolCallId>` —
 *  the answer cards read their short "why" from here. Empty outside a chat
 *  (tests, previews), which renders no analysis. */
export const MistakesContext = createContext<ReadonlyMap<string, MistakeRecord>>(new Map());

/** Load a session's mistakes; refresh when they change (analysis landing). */
export function useChatMistakes(chatId: string): ReadonlyMap<string, MistakeRecord> {
	const [map, setMap] = useState<ReadonlyMap<string, MistakeRecord>>(new Map());
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/mistakes`, { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as { mistakes?: MistakeRecord[] };
			setMap(new Map((body.mistakes ?? []).map((m) => [m.id, m])));
		} catch {
			/* keep what we have */
		}
	}, [chatId]);
	useEffect(() => {
		void load();
		return () => clearTimeout(timer.current);
	}, [load]);
	const schedule = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => void load(), 250);
	}, [load]);
	useServerEvent("mistakes-changed", schedule);
	// A turn settling is when new misses get recorded.
	useServerEvent("turn-settled", (p) => {
		if (p.chatId === chatId) setTimeout(() => void load(), 800);
	});
	return map;
}
