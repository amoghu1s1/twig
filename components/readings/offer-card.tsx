"use client";

/**
 * The teacher's reading OFFER (suggest_reading — docs/readings.md §6.2):
 * a quiet card in the transcript. Nothing has been written; one click
 * opts in (with the source-mode choice) and opens the reading in the
 * tray. Once written, the card links to it instead.
 */

import { useState } from "react";
import { BookOpenIcon } from "lucide-react";
import type { ArtifactPartProps, ReadingSuggestion } from "@/src/core";
import { READING_KIND_LABEL } from "@/src/core";
import { useSessionReadings } from "@/components/readings/api";
import { ModeToggle } from "@/components/readings/reading-view";

export function ReadingOfferCard({ part }: ArtifactPartProps) {
	const seam = useSessionReadings();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = part.input as Partial<ReadingSuggestion> | undefined;
	if (!input?.title || !input.kind) return null;
	// A refused call (bad node id) rendered nothing to the learner.
	if (part.state === "output-error") return null;
	const written = seam?.readings.find((r) => r.anchor.suggestionCallId === part.toolCallId);

	const write = async () => {
		if (!seam) return;
		setBusy(true);
		setError(null);
		const err = await seam.request({
			kind: input.kind!,
			...(input.planNodeId ? { planNodeId: input.planNodeId } : {}),
			suggestionCallId: part.toolCallId,
		});
		setBusy(false);
		if (err) setError(err);
	};

	return (
		<div data-testid="reading-offer" className="my-1 flex flex-col gap-2 rounded-xl border border-dashed border-border/80 px-3.5 py-3">
			<div className="flex items-center gap-2 font-ui text-xs uppercase tracking-wide text-muted-foreground">
				<BookOpenIcon className="size-3.5 text-primary" aria-hidden />
				Optional reading · {READING_KIND_LABEL[input.kind]}
			</div>
			<div className="text-sm font-medium">{input.title}</div>
			{input.why && <div className="text-sm text-muted-foreground">{input.why}</div>}
			{seam && (
				<div className="flex flex-wrap items-center gap-2 pt-1">
					{written ? (
						<button
							type="button"
							onClick={() => seam.open(written.id)}
							className="rounded-full border border-border px-3 py-1 font-ui text-xs hover:bg-accent"
						>
							Open the reading
						</button>
					) : (
						<>
							<button
								type="button"
								data-testid="reading-offer-accept"
								disabled={busy}
								onClick={() => void write()}
								className="rounded-full bg-primary px-3 py-1 font-ui text-xs font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
							>
								Write it
							</button>
							<ModeToggle mode={seam.mode} onChange={seam.setMode} size="xs" />
						</>
					)}
				</div>
			)}
			{error && <div className="font-ui text-xs text-destructive">{error}</div>}
		</div>
	);
}
