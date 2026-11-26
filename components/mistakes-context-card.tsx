"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { MistakeSeedItem } from "@/src/core";
import { cn } from "@/lib/utils";

export interface MistakesContextData {
	mistakes: MistakeSeedItem[];
}

export function MistakesContextCard({ data }: { data: MistakesContextData }) {
	const [open, setOpen] = useState(false);
	const mistakes = data?.mistakes ?? [];
	const noun = `${mistakes.length} ${mistakes.length === 1 ? "mistake" : "mistakes"}`;
	return (
		<div data-testid="mistakes-context-card" className="my-1">
			<button
				type="button"
				data-testid="mistakes-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Mistakes context</span>
				<span className="min-w-0 flex-1 truncate">{noun}</span>
			</button>
			{open && (
				<div data-testid="mistakes-context-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{mistakes.map((m) => (
						<div key={m.id} className="space-y-0.5 leading-relaxed">
							<div className="font-medium text-foreground/85">
								{[m.topic, m.errorType].filter(Boolean).join(" · ") || "Previous miss"}
							</div>
							{m.whatYouDid && <div className="text-muted-foreground">{m.whatYouDid}</div>}
							{m.rule && <div className="text-muted-foreground/90">Rule: {m.rule}</div>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
