"use client";

/**
 * The artifact download menu (security review, ported from the
 * jacobderechin fork, 2026-11-08): the SAFE export first — a sandboxed demo
 * viewer / a PNG figure, which keep their protections outside the app — and
 * the raw generated source second, labeled as untrusted code (opened on its
 * own it runs without the app's CSP and iframe sandbox). Inline dropdown
 * (not portaled) so the click-outside dismissal sees the items as inside.
 */

import { useCallback, useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { usePopoverDismiss } from "@/components/popover-dismiss";

export interface DownloadChoice {
	label: string;
	hint: string;
	testid: string;
	run: () => void | Promise<void>;
}

export function DownloadMenu({
	ariaLabel,
	testid,
	safe,
	source,
}: {
	ariaLabel: string;
	testid: string;
	safe: DownloadChoice;
	source: DownloadChoice;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);
	usePopoverDismiss(rootRef, open, close);
	const item = (choice: DownloadChoice, warn: boolean) => (
		<button
			type="button"
			role="menuitem"
			data-testid={choice.testid}
			onClick={() => {
				close();
				void choice.run();
			}}
			className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent"
		>
			<span className={warn ? "text-xs font-medium text-destructive" : "text-xs font-medium text-foreground"}>{choice.label}</span>
			<span className="text-[11px] text-muted-foreground">{choice.hint}</span>
		</button>
	);
	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				aria-label={ariaLabel}
				aria-haspopup="menu"
				aria-expanded={open}
				title={ariaLabel}
				onClick={() => setOpen((v) => !v)}
				data-testid={testid}
				className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<DownloadIcon className="size-3.5" />
			</button>
			{open && (
				<div
					role="menu"
					data-testid={`${testid}-menu`}
					className="absolute right-0 top-full z-50 mt-1 flex w-64 flex-col gap-0.5 rounded-xl border border-border bg-card p-1.5 shadow-xl"
				>
					{item(safe, false)}
					{item(source, true)}
				</div>
			)}
		</div>
	);
}
