"use client";

/**
 * Readings on a graph node (docs/readings.md §7): the detail card's
 * section — readings that picked this node or came from a session it came
 * up in (a read-time fold; nothing is written into the graph) — plus the
 * "Deep dive" action that writes a new one.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpenIcon } from "lucide-react";
import { requestReading, useReadingMode, useReadings } from "@/components/readings/api";

/** Create a node reading and open it (the graph's entry point). Router-
 *  free by default (navigation happens only on click), so surfaces rendered
 *  outside the app router — static renders, tests — can mount it. */
export function useNodeDeepDive(
	navigate: (href: string) => void = (href) => window.location.assign(href),
): { start: (nodeIds: string[]) => Promise<void>; busy: boolean; error: string | null } {
	const [mode] = useReadingMode();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const start = async (nodeIds: string[]) => {
		if (nodeIds.length === 0) return;
		setBusy(true);
		setError(null);
		const res = await requestReading({ kind: "node", nodeIds, mode });
		setBusy(false);
		if (!res.ok) return setError(res.error);
		navigate(`/readings/${res.id}`);
	};
	return { start, busy, error };
}

export function NodeReadings({ nodeId }: { nodeId: string }) {
	const router = useRouter();
	const { readings } = useReadings({ nodeId });
	const { start, busy, error } = useNodeDeepDive((href) => router.push(href));
	const ready = (readings ?? []).slice(0, 5);
	return (
		<div data-testid="node-readings" className="mt-3 flex flex-col gap-1">
			<div className="flex items-center text-xs text-muted-foreground">
				Readings
				<button
					type="button"
					data-testid="node-deep-dive"
					disabled={busy}
					onClick={() => void start([nodeId])}
					className="ml-auto flex items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-60"
				>
					<BookOpenIcon className="size-3 text-primary" /> Deep dive
				</button>
			</div>
			{ready.map((r) => (
				<button
					key={r.id}
					type="button"
					onClick={() => router.push(`/readings/${r.id}`)}
					className="min-w-0 truncate rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent"
				>
					{r.title}
				</button>
			))}
			{error && <div className="text-xs text-destructive">{error}</div>}
		</div>
	);
}
