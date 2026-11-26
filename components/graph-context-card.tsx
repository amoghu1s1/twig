"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The graph-context card (owner, 2026-10-04): the session's map pick —
 * message[0] of a session started with propositions picked from the
 * graph. Also shows Practice v2's strict 1-hop nearby context when present.
 */

export interface GraphContextData {
	propositions: { id: string; name: string; statement: string }[];
	chains: string[];
	neighbors?: { id: string; name: string; statement: string }[];
	neighborChains?: string[];
}

export function GraphContextCard({ data }: { data: GraphContextData }) {
	const [open, setOpen] = useState(false);
	const { propositions = [], chains = [], neighbors = [], neighborChains = [] } = data ?? {};
	const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	return (
		<div data-testid="graph-context-card" className="my-1">
			<button
				type="button"
				data-testid="graph-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Graph context</span>
				<span className="min-w-0 flex-1 truncate">
					{noun(propositions.length, "proposition", "propositions")}
					{chains.length > 0 ? ` · ${noun(chains.length, "chain", "chains")}` : ""}
					{neighbors.length > 0 ? ` · ${noun(neighbors.length, "nearby node", "nearby nodes")}` : ""}
				</span>
			</button>
			{open && (
				<div data-testid="graph-context-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					<div className="space-y-1">
						{propositions.map((p) => (
							<div key={p.id} data-testid={`graph-context-prop-${p.id}`} className="leading-relaxed">
								<span className="font-medium text-foreground/80">{p.name}</span>
								<span className="text-muted-foreground"> — {p.statement}</span>
							</div>
						))}
						{chains.length > 0 && (
							<div className="pt-1">
								{chains.map((c, i) => (
									<div key={i} className="font-mono text-[11px] text-muted-foreground">
										{c}
									</div>
								))}
							</div>
						)}
					</div>
					{neighbors.length > 0 && (
						<div data-testid="graph-context-neighbors" className="space-y-1 border-t border-border/60 pt-2">
							<div className="font-ui text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
								Nearby context (not targets)
							</div>
							{neighbors.map((n) => (
								<div key={n.id} className="leading-relaxed text-muted-foreground/90">
									<span className="font-medium">{n.name}</span>
									<span> — {n.statement}</span>
								</div>
							))}
							{neighborChains.length > 0 && (
								<div className="pt-1">
									{neighborChains.map((c, i) => (
										<div key={i} className="font-mono text-[11px] text-muted-foreground/80">
											{c}
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
