"use client";

import { useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, RefreshCwIcon, SearchIcon, Table2Icon } from "lucide-react";
import type { KernelVariable } from "@/src/core";

export function VariableInspector({
	variables,
	open,
	onToggleOpen,
	onRefresh,
}: {
	variables: readonly KernelVariable[];
	open: boolean;
	onToggleOpen: () => void;
	onRefresh: () => void;
}) {
	const [query, setQuery] = useState("");
	const filtered = query.trim()
		? variables.filter(
				(v) =>
					v.name.toLowerCase().includes(query.trim().toLowerCase()) ||
					v.typeName.toLowerCase().includes(query.trim().toLowerCase()),
		  )
		: variables;

	return (
		<div className="shrink-0 border-t border-border bg-card/60" data-testid="lab-variable-inspector">
			{open && (
				<div className="max-h-56 overflow-y-auto border-b border-border/70 bg-background/70 px-3 py-2">
					<div className="mb-2 flex items-center justify-between gap-2">
						<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
							Live Variables ({variables.length})
						</span>
						<div className="flex items-center gap-2">
							<label className="relative flex items-center">
								<SearchIcon className="pointer-events-none absolute left-2 size-3 text-muted-foreground" />
								<input
									type="text"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="Filter…"
									aria-label="Filter kernel variables"
									className="h-6 w-36 rounded border border-border bg-card pl-6 pr-2 font-mono text-[11px] text-foreground outline-none focus:border-muted-foreground"
								/>
							</label>
							<button
								type="button"
								onClick={onRefresh}
								title="Refresh variables"
								aria-label="Refresh variables"
								className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<RefreshCwIcon className="size-3" />
							</button>
						</div>
					</div>
					{filtered.length === 0 ? (
						<p className="py-2 text-xs text-muted-foreground">
							{variables.length === 0
								? "No live variables yet. Run a cell to populate kernel memory."
								: "No matching variables."}
						</p>
					) : (
						<table className="w-full border-collapse font-mono text-[11px]">
							<thead>
								<tr className="border-b border-border/60 text-left text-muted-foreground">
									<th className="py-1 pr-3 font-medium">Name</th>
									<th className="py-1 pr-3 font-medium">Type</th>
									<th className="py-1 pr-3 font-medium">Shape / Size</th>
									<th className="py-1 pr-3 font-medium">Dtype / Device</th>
									<th className="py-1 font-medium">Value</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map((v) => (
									<tr key={v.name} className="border-b border-border/40 last:border-b-0">
										<td className="py-1 pr-3 font-medium text-foreground">{v.name}</td>
										<td className="py-1 pr-3 text-muted-foreground">{v.typeName}</td>
										<td className="py-1 pr-3 text-muted-foreground">
											{v.shape ? `(${v.shape.join(", ")})` : (v.sizeHint ?? "—")}
										</td>
										<td className="py-1 pr-3 text-muted-foreground">
											{[v.dtype, v.device].filter(Boolean).join(" · ") || "—"}
										</td>
										<td className="max-w-xs truncate py-1 text-foreground/85">{v.summary}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			)}

			{/* Compact footer strip */}
			<button
				type="button"
				onClick={onToggleOpen}
				data-testid="lab-variables-toggle"
				className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
			>
				<Table2Icon className="size-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate">
					{variables.length === 0 ? (
						"Kernel namespace empty"
					) : (
						variables.slice(0, 4).map((v, i) => (
							<span key={v.name}>
								{i > 0 && " · "}
								<strong className="font-medium text-foreground">{v.name}</strong>:{" "}
								{v.shape ? `${v.typeName}(${v.shape.join(", ")})` : v.typeName}
								{v.dtype ? ` ${v.dtype}` : ""}
							</span>
						))
					)}
					{variables.length > 4 && ` · +${variables.length - 4} more`}
				</span>
				{open ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronUpIcon className="size-3.5 shrink-0" />}
			</button>
		</div>
	);
}
