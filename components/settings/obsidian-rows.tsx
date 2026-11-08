"use client";

/**
 * The graph section's Obsidian rows (src/server/obsidian-sync.ts): the
 * auto-write switch, and the vault's location with a Write now button.
 */

import { useEffect, useState } from "react";
import type { GraphSettings } from "@/src/core";
import { SettingsRow, Toggle } from "./controls.tsx";

const buttonClass = "flex h-7 items-center rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-50";

export function ObsidianRows({ graph, onSectionChange }: { graph: GraphSettings | undefined; onSectionChange: (next: GraphSettings) => void }) {
	const [vault, setVault] = useState("");
	const [note, setNote] = useState("");
	const [writing, setWriting] = useState(false);
	useEffect(() => {
		void fetch("/api/obsidian").then(async (r) => { if (r.ok) setVault(((await r.json()) as { vault: string }).vault); }).catch(() => {});
	}, []);
	const write = async () => {
		setWriting(true);
		setNote("Writing notes…");
		try {
			const response = await fetch("/api/obsidian", { method: "POST" });
			const body = (await response.json()) as { error?: string; notes?: number; written?: number; removed?: number };
			setNote(response.ok ? `${body.notes} notes · ${body.written} updated · ${body.removed} removed` : body.error ?? "Could not write the vault.");
		} catch (err) {
			setNote(err instanceof Error ? err.message : String(err));
		} finally {
			setWriting(false);
		}
	};
	return (
		<>
			<SettingsRow label="Obsidian sync" hint="On = the Obsidian vault is rewritten after each extraction and tidy" testid="graph-row-obsidian-sync">
				<Toggle
					checked={graph?.obsidianSync ?? false}
					label="obsidian sync enabled"
					onChange={(on) => onSectionChange({ ...graph, obsidianSync: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Obsidian vault" hint={note || vault || "…"} testid="graph-row-obsidian">
				<button type="button" className={buttonClass} disabled={writing} onClick={() => void write()} data-testid="obsidian-write">
					Write now
				</button>
			</SettingsRow>
		</>
	);
}
