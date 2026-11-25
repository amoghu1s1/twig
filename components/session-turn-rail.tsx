"use client";

import { useEffect, useState, type RefObject } from "react";
import type { LhViewMessage } from "@/src/core";
import { scrollSessionTarget, type SessionScrollContext } from "@/components/session-navigation";
import { cn } from "@/lib/utils";

export interface SessionTurnItem {
	id: string;
	index: number;
	role: "user" | "assistant";
	label: string;
}

function summarizeTurnText(raw: string, fallback: string): string {
	const cleaned = raw
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_`>#]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return fallback;
	return cleaned.length > 64 ? `${cleaned.slice(0, 63)}…` : cleaned;
}

/** Extract visible conversation turns (skipping internal scaffolding markers)
 *  for the right-margin turn-rail scrubber. */
export function extractSessionTurns(messages: readonly LhViewMessage[]): SessionTurnItem[] {
	const turns: SessionTurnItem[] = [];
	for (const m of messages) {
		if (!m.id) continue;
		if (m.role === "user") {
			if ((m.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null) continue;
			if (m.parts.some((p) => p.type === "data-probe-handoff")) continue;
			if (m.parts.length > 0 && m.parts.every((p) => p.type.startsWith("data-"))) continue;
			const text = m.parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text!).join(" ");
			turns.push({
				id: m.id,
				index: turns.length + 1,
				role: "user",
				label: summarizeTurnText(text, "Your message"),
			});
			continue;
		}
		const text = m.parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text!).join(" ");
		const firstHeading = text.match(/^#{1,4}\s+(.+)$/m)?.[1];
		turns.push({
			id: m.id,
			index: turns.length + 1,
			role: "assistant",
			label: summarizeTurnText(firstHeading ?? text, "Tutor response"),
		});
	}
	return turns;
}

/** Subtle vertical dot rail along the right margin of the transcript for quick
 *  turn-to-turn jumping. Hidden on narrow screens or short (<2 turn) sessions. */
export function SessionTurnRail({
	turns,
	scopeRef,
	scrollContextRef,
	onJumpTurn,
}: {
	turns: readonly SessionTurnItem[];
	scopeRef: RefObject<HTMLDivElement | null>;
	scrollContextRef: RefObject<SessionScrollContext | null>;
	onJumpTurn?: (turnId: string) => void;
}) {
	const [activeId, setActiveId] = useState<string | null>(turns.at(-1)?.id ?? null);
	const [hovered, setHovered] = useState<{ turn: SessionTurnItem; top: number; right: number } | null>(null);

	useEffect(() => {
		const scope = scopeRef.current;
		const root = scrollContextRef.current?.scrollRef.current ?? null;
		if (!scope || turns.length < 2 || typeof IntersectionObserver === "undefined") return;
		const elements = turns
			.map((t) => scope.querySelector<HTMLElement>(`[data-turn-anchor="${CSS.escape(t.id)}"]`))
			.filter((el): el is HTMLElement => el !== null);
		if (elements.length === 0) return;

		const visible = new Set<string>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = entry.target.getAttribute("data-turn-anchor");
					if (!id) continue;
					if (entry.isIntersecting) visible.add(id);
					else visible.delete(id);
				}
				const latestVisible = [...turns].reverse().find((t) => visible.has(t.id));
				if (latestVisible) setActiveId(latestVisible.id);
			},
			{ root, threshold: 0.05, rootMargin: "-10% 0px -15% 0px" },
		);
		for (const el of elements) observer.observe(el);
		return () => observer.disconnect();
	}, [turns, scopeRef, scrollContextRef]);

	if (turns.length < 2) return null;

	const jump = (turnId: string) => {
		if (onJumpTurn) {
			onJumpTurn(turnId);
			return;
		}
		const scope = scopeRef.current;
		if (!scope) return;
		const target = scope.querySelector<HTMLElement>(`[data-turn-anchor="${CSS.escape(turnId)}"]`);
		if (target) scrollSessionTarget(target, scope, scrollContextRef.current);
	};

	return (
		<nav
			aria-label="Turn navigation"
			data-testid="session-turn-rail"
			className="pointer-events-auto absolute right-2.5 top-1/2 z-20 hidden max-h-[60%] -translate-y-1/2 flex-col items-center gap-1.5 overflow-y-auto px-1 py-2 xl:flex"
		>
			{hovered && (
				<div
					role="tooltip"
					className="pointer-events-none fixed z-30 max-w-56 truncate rounded-md border bg-popover px-2 py-1 font-ui text-[11px] text-popover-foreground shadow-md"
					style={{ top: hovered.top, right: hovered.right, transform: "translateY(-50%)" }}
				>
					<span className="text-muted-foreground">{hovered.turn.role === "user" ? "You" : "Tutor"} #{hovered.turn.index}: </span>
					{hovered.turn.label}
				</div>
			)}
			{turns.map((turn) => {
				const active = turn.id === activeId;
				return (
					<button
						key={turn.id}
						type="button"
						data-testid={`turn-rail-dot-${turn.id}`}
						aria-label={`Jump to ${turn.role === "user" ? "your message" : "tutor turn"} ${turn.index}: ${turn.label}`}
						aria-current={active ? "true" : undefined}
						onMouseEnter={(e) => {
							const rect = e.currentTarget.getBoundingClientRect();
							setHovered({ turn, top: rect.top + rect.height / 2, right: window.innerWidth - rect.left + 10 });
						}}
						onMouseLeave={() => setHovered((cur) => (cur?.turn.id === turn.id ? null : cur))}
						onFocus={(e) => {
							const rect = e.currentTarget.getBoundingClientRect();
							setHovered({ turn, top: rect.top + rect.height / 2, right: window.innerWidth - rect.left + 10 });
						}}
						onBlur={() => setHovered((cur) => (cur?.turn.id === turn.id ? null : cur))}
						onClick={() => {
							setActiveId(turn.id);
							jump(turn.id);
						}}
						className={cn(
							"block shrink-0 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							turn.role === "user" ? "size-2" : "size-1.5",
							active
								? "scale-125 bg-foreground/80"
								: "bg-muted-foreground/30 hover:scale-125 hover:bg-muted-foreground/70",
						)}
					/>
				);
			})}
		</nav>
	);
}
