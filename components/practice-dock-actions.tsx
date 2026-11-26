"use client";

import { useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRightIcon, EyeIcon, FlagIcon, LightbulbIcon, MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { useInteractionLayers, useOptionalInteractionLayers } from "@/components/interaction-layers";
import type { PracticeThinkingAction } from "@/src/core";

function MoreActionsPopover({
	rootRef,
	triggerRef,
	anchor,
	onClose,
	onAction,
}: {
	rootRef: RefObject<HTMLDivElement | null>;
	triggerRef: RefObject<HTMLButtonElement | null>;
	anchor: { top: number; right: number };
	onClose: () => void;
	onAction: (action: Exclude<PracticeThinkingAction, "submit">) => void;
}) {
	const panelRef = useRef<HTMLDivElement | null>(null);
	const interactions = useInteractionLayers();
	const popupLayer = usePopoverDismiss(rootRef, true, onClose, { layerRootRef: panelRef });
	return createPortal(
		<div
			ref={panelRef}
			data-testid="practice-more-menu"
			style={{
				position: "fixed",
				top: anchor.top,
				right: anchor.right,
				transform: "translateY(-100%)",
				zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order,
			}}
			className="w-52 rounded-xl border bg-card p-1 text-left shadow-lg"
		>
			<button
				type="button"
				data-testid="practice-step-down"
				onClick={() => onAction("step-down")}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
			>
				<ArrowDownRightIcon className="size-3.5 text-muted-foreground" />
				<span>Easier / Step down</span>
			</button>
			<button
				type="button"
				data-testid="practice-flag-bad"
				onClick={() => onAction("flag-bad")}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
			>
				<FlagIcon className="size-3.5 text-muted-foreground" />
				<span>Flag bad question</span>
			</button>
		</div>,
		interactions.getPortalContainer(triggerRef.current)!,
	);
}

/**
 * Shared compact action bar for every Practice v2 dock (Open, Check, Match, Code):
 * quiet ghost Hint + Show solution buttons, an uncluttered `⋯` menu for
 * Easier / Step down and Flag bad question, and the format's primary submit slot.
 */
export function PracticeDockActionBar({
	disabled,
	leftSlot,
	onAction,
	submitButton,
}: {
	disabled?: boolean;
	leftSlot?: ReactNode;
	onAction: (action: Exclude<PracticeThinkingAction, "submit">) => void;
	submitButton: ReactNode;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const interactions = useOptionalInteractionLayers();

	const fire = (action: Exclude<PracticeThinkingAction, "submit">) => {
		setMenuOpen(false);
		onAction(action);
	};

	return (
		<div className="flex flex-wrap items-center justify-between gap-2 p-1">
			<div className="flex min-w-0 items-center gap-1.5 pl-1">{leftSlot}</div>
			<div className="ml-auto flex items-center gap-1">
				<div ref={rootRef} className="relative">
					<Button
						ref={triggerRef}
						type="button"
						variant="ghost"
						size="sm"
						data-testid="practice-more-actions"
						aria-label="More problem actions"
						aria-expanded={menuOpen}
						disabled={disabled}
						onClick={() => {
							setMenuOpen((prev) => {
								if (prev) return false;
								const r = triggerRef.current?.getBoundingClientRect();
								if (r) {
									setAnchor({
										top: Math.max(8, r.top - 8),
										right: Math.max(8, window.innerWidth - r.right),
									});
								}
								return true;
							});
						}}
						className="h-8 px-2 text-muted-foreground hover:text-foreground"
					>
						<MoreHorizontalIcon className="size-4" />
					</Button>
					{menuOpen && anchor && interactions && (
						<MoreActionsPopover
							rootRef={rootRef}
							triggerRef={triggerRef}
							anchor={anchor}
							onClose={() => setMenuOpen(false)}
							onAction={fire}
						/>
					)}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					data-testid="practice-hint"
					disabled={disabled}
					onClick={() => fire("hint")}
					className="h-8 gap-1 px-2.5 text-xs text-muted-foreground hover:text-foreground"
				>
					<LightbulbIcon className="size-3.5" />
					Hint
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					data-testid="practice-show-solution"
					disabled={disabled}
					onClick={() => fire("show-solution")}
					className="h-8 gap-1 px-2.5 text-xs text-muted-foreground hover:text-foreground"
				>
					<EyeIcon className="size-3.5" />
					Show solution
				</Button>
				{submitButton}
			</div>
		</div>
	);
}
