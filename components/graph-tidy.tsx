"use client";

/**
 * Tidy graph (src/server/graph-tidy.ts): the chains bar's wand opens a
 * panel that runs the tidier and lists its proposals (merge, split,
 * connect) for the learner to apply or skip, one by one or all at once.
 * An apply fires lh:graph-revision so the chains and canvas re-read.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { WandSparklesIcon, XIcon } from "lucide-react";
import type { GraphNode, TidyProposal } from "@/src/core";

interface TidyStatusBody {
	running: boolean;
	error?: string;
	runAt?: string;
	proposals: TidyProposal[];
}

const quote = (text: string) => `“${text}”`;

/** One proposal as a sentence over node names (exported for tests). */
export function describeTidy(proposal: TidyProposal, names: ReadonlyMap<string, string>): { title: string; detail?: string } {
	const name = (id: string) => quote(names.get(id) ?? id);
	const change = proposal.change;
	switch (change.kind) {
		case "merge":
			return { title: `Merge ${name(change.drop)} into ${name(change.keep)}` };
		case "split":
			return { title: `Split ${name(change.node)}`, detail: change.parts.map((p) => p.name).join(" · ") };
		case "connect": {
			const from = change.premises.map(name).join(" + ");
			if (change.conclusion) return { title: `${from} ⟹ ${name(change.conclusion)}` };
			return { title: `${from} ⟹ new idea ${quote(change.newIdea?.name ?? "")}`, detail: change.newIdea?.statement };
		}
	}
}

const KIND_ORDER = { connect: 0, merge: 1, split: 2 } as const;
const KIND_HEADING = { connect: "Connections", merge: "Same idea twice", split: "Bundled ideas" } as const;

export function TidyGraphButton({ nodes }: { nodes: GraphNode[] }) {
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<TidyStatusBody | null>(null);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const names = new Map(nodes.map((n) => [n.id, n.name]));
	const panelRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/graph/tidy", { cache: "no-store" });
			if (response.ok) setStatus((await response.json()) as TidyStatusBody);
		} catch {
			/* the panel keeps its last read */
		}
	}, []);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);
	useEffect(() => {
		if (!open || !status?.running) return;
		const timer = setInterval(() => void load(), 2000);
		return () => clearInterval(timer);
	}, [open, status?.running, load]);

	const run = async () => {
		setNote("");
		const response = await fetch("/api/graph/tidy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run" }) });
		if (!response.ok && response.status !== 409) {
			const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
			setNote(body.error ?? body.message ?? "Could not start the tidy pass. Check the Strong model in Settings.");
		}
		void load();
	};

	const resolve = async (ids: string[], action: "apply" | "skip") => {
		if (ids.length === 0) return;
		setBusy(true);
		try {
			const response = await fetch("/api/graph/tidy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ids }) });
			const body = (await response.json()) as { error?: string; applied?: number; failed?: Array<{ error: string }> };
			if (!response.ok) setNote(body.error ?? "Could not update the graph.");
			else if (action === "apply") {
				setNote(`Applied ${body.applied ?? 0}${body.failed?.length ? ` · ${body.failed.length} no longer fit the graph` : ""}`);
				window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: {} }));
			}
		} finally {
			setBusy(false);
			void load();
		}
	};

	const pending = (status?.proposals ?? []).filter((p) => p.status === "pending")
		.sort((a, b) => KIND_ORDER[a.change.kind] - KIND_ORDER[b.change.kind]);
	const running = status?.running === true;

	return (
		<div className="relative shrink-0">
			<button
				type="button"
				data-testid="tidy-graph-open"
				aria-label="Tidy graph"
				title="Tidy graph: find connections between topics"
				onClick={() => setOpen((v) => !v)}
				className="lh-no-drag rounded-lg p-2 text-muted-foreground hover:bg-accent"
			>
				<WandSparklesIcon className="size-4" />
			</button>
			{open && (
				<div
					ref={panelRef}
					data-testid="tidy-graph-panel"
					className="lh-no-drag absolute right-0 top-10 z-30 flex max-h-[70vh] w-[min(34rem,calc(100vw-2rem))] flex-col rounded-xl border bg-popover text-sm shadow-lg"
				>
					<div className="flex items-center gap-2 border-b px-3 py-2">
						<span className="flex-1 font-medium">Tidy graph</span>
						<button
							type="button"
							data-testid="tidy-graph-run"
							disabled={running}
							onClick={() => void run()}
							className="rounded-lg border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
						>
							{running ? "Looking for connections…" : status?.runAt ? "Look again" : "Find connections"}
						</button>
						<button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded-lg p-1 text-muted-foreground hover:bg-accent">
							<XIcon className="size-4" />
						</button>
					</div>
					<div className="flex-1 overflow-y-auto px-3 py-2">
						{status?.error && <p role="alert" className="pb-2 text-xs text-red-400">{status.error}</p>}
						{note && <p className="pb-2 text-xs text-muted-foreground">{note}</p>}
						{pending.length === 0 ? (
							<p className="py-4 text-center text-xs text-muted-foreground">
								{running
									? "Reading the whole graph. This can take a minute."
									: status?.runAt
										? "Nothing waiting. Run it again after new lessons."
										: "Reads your whole graph and suggests links between topics, ideas stated twice, and ideas that bundle separate facts. You approve each change."}
							</p>
						) : (
							pending.map((proposal, i) => {
								const { title, detail } = describeTidy(proposal, names);
								const heading = i === 0 || pending[i - 1]!.change.kind !== proposal.change.kind ? KIND_HEADING[proposal.change.kind] : null;
								return (
									<div key={proposal.id}>
										{heading && <p className="pb-1 pt-2 text-[11px] uppercase tracking-widest text-muted-foreground/70">{heading}</p>}
										<div data-testid="tidy-proposal" className="mb-2 rounded-lg border px-2.5 py-2">
											<p className="text-foreground">{title}</p>
											{detail && <p className="pt-0.5 text-xs text-foreground/80">{detail}</p>}
											<p className="pt-1 text-xs text-muted-foreground">{proposal.reason}</p>
											<div className="flex justify-end gap-1 pt-1.5">
												<button type="button" disabled={busy} onClick={() => void resolve([proposal.id], "skip")}
													className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">Skip</button>
												<button type="button" disabled={busy} onClick={() => void resolve([proposal.id], "apply")}
													className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50">Apply</button>
											</div>
										</div>
									</div>
								);
							})
						)}
					</div>
					{pending.length > 1 && (
						<div className="flex justify-end gap-2 border-t px-3 py-2">
							<button type="button" disabled={busy} onClick={() => void resolve(pending.map((p) => p.id), "skip")}
								className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">Skip all</button>
							<button type="button" disabled={busy} data-testid="tidy-apply-all" onClick={() => void resolve(pending.map((p) => p.id), "apply")}
								className="rounded-lg border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">Apply all ({pending.length})</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
