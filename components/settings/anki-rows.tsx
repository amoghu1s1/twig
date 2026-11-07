"use client";

/**
 * The graph section's Anki rows (src/server/anki-sync.ts): the auto-sync
 * switch, and a status row that sends everything now or downloads the
 * File > Import fallback. The status line reads GET /api/anki once on
 * mount and again after each send.
 */

import { useCallback, useEffect, useState } from "react";
import type { GraphSettings } from "@/src/core";
import { SettingsRow, Toggle } from "./controls.tsx";

interface AnkiStatus {
	ankiReachable: boolean;
	carded: number;
	waiting: number;
	uncarded: number;
}

const buttonClass = "flex h-7 items-center rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-50";

export function ankiStatusLine(status: AnkiStatus | null, note: string): string {
	if (note) return note;
	if (!status) return "Checking Anki…";
	const anki = status.ankiReachable ? "Anki connected" : "Anki not reachable (open Anki with AnkiConnect)";
	return `${anki} · ${status.carded} carded · ${status.waiting} waiting · ${status.uncarded} not carded`;
}

export function AnkiRows({ graph, onSectionChange }: { graph: GraphSettings | undefined; onSectionChange: (next: GraphSettings) => void }) {
	const [status, setStatus] = useState<AnkiStatus | null>(null);
	const [sending, setSending] = useState(false);
	const [note, setNote] = useState("");
	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/anki");
			if (response.ok) setStatus((await response.json()) as AnkiStatus);
		} catch {
			// the status line keeps its last value
		}
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);
	const sendAll = async () => {
		setSending(true);
		setNote("Writing cards and sending to Anki…");
		try {
			const response = await fetch("/api/anki", { method: "POST" });
			const body = (await response.json()) as { error?: string; carded?: number; added?: number; waiting?: number };
			setNote(response.ok ? `Carded ${body.carded} · added ${body.added} to Anki · ${body.waiting} waiting` : body.error ?? "Could not send to Anki.");
		} catch (err) {
			setNote(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
			void refresh();
		}
	};
	return (
		<>
			<SettingsRow label="Anki sync" hint="On = new propositions become Anki cards after each extraction" testid="graph-row-anki-sync">
				<Toggle
					checked={graph?.ankiSync ?? false}
					label="anki sync enabled"
					onChange={(on) => onSectionChange({ ...graph, ankiSync: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Anki" hint={ankiStatusLine(status, note)} testid="graph-row-anki">
				<span className="flex shrink-0 gap-1.5">
					<button type="button" className={buttonClass} disabled={sending} onClick={() => void sendAll()} data-testid="anki-send-all">
						Send all
					</button>
					<a className={buttonClass} href="/api/anki?format=import" download data-testid="anki-download">
						Import file
					</a>
				</span>
			</SettingsRow>
		</>
	);
}
