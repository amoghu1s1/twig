"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ViewReaderRef } from "./session-view-readers";
import { ChevronRightIcon, PaperclipIcon, PenToolIcon, XIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { useEnterSubmits } from "@/components/enter-submits";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";
import { PathInput } from "@/components/path-input";
import { clipboardImageFiles, normalizeImageFile } from "@/components/draft-images";
import { drawingKeyForPath } from "@/components/scratchpad/model";
import { snapshotScratchpadPng } from "@/components/scratchpad/export";
import { PracticeDockActionBar } from "@/components/practice-dock-actions";
import type { PrepareThinkingSubmission } from "./plugin-submission-adapters";
import { imageUrl, type PracticeThinkingAction } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The Practice v2 open-ended dock:
 * - Statement above, "Your thinking" below, clean action hierarchy:
 *   attach image / scratchpad on the left; `⋯` (Easier / Flag bad), Hint
 *   (preserves your draft), Show solution, and Submit thinking on the right.
 * - Stays mounted (via `hidden={!expanded}`) when collapsed on scroll so
 *   half-written traces, cursor position, and attached images survive.
 * - Window-level Enter-from-anywhere is armed only while voice dictation is active.
 */

export interface PracticeDockProps {
	viewReader?: ViewReaderRef<string>;
	/** The active problem's tool-call id (submissions target it). */
	problemCallId: string;
	/** The pose's arguments — only the statement is the learner's. */
	input: { statement: string };
	/** Collapse state, owned by the DockOverlay. */
	expanded: boolean;
	onExpand: () => void;
	/** text — POST {type:"thinking"} (optional action & images). */
	onSubmit: (text: string, action?: PracticeThinkingAction, images?: ImageContent[]) => void;
	onPrepareSubmission?: PrepareThinkingSubmission;
	/** Host-owned alternative editor. The native statement/thinking/controls stay shared. */
	customInput?: {
		editor: ReactNode;
		thinking: string;
		onThinkingChange(value: string): void;
		ready: boolean;
		prepare: PrepareThinkingSubmission;
	};
	hasPendingInput?: boolean;
	preparing?: boolean;
	/** Escape in the thinking field stops dictation (threaded from the page). */
	onEscape?: () => void;
	/** Compaction is running for this chat. */
	compactionRunning?: boolean;
}

export function PracticeDock({
	viewReader,
	problemCallId,
	input,
	expanded,
	onExpand,
	onSubmit,
	onPrepareSubmission,
	customInput,
	hasPendingInput = false,
	preparing = false,
	onEscape,
	compactionRunning = false,
}: PracticeDockProps) {
	const controller = useOptionalInteractionLayers();
	const pathname = usePathname();
	const rootRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [nativeThinking, setNativeThinking] = useState("");
	const [attachedImages, setAttachedImages] = useState<ImageContent[]>([]);
	const [attachNotice, setAttachNotice] = useState<string | null>(null);
	const custom = useRef(customInput);
	custom.current = customInput;
	const thinking = customInput ? customInput.thinking : nativeThinking;
	const setThinking = (value: string) => {
		if (custom.current) custom.current.onThinkingChange(value);
		else setNativeThinking(value);
	};
	// Ref mirrors the field ("nothing gets lost") so dictation flushes read the tail.
	const thinkingRef = useRef(thinking);
	thinkingRef.current = thinking;
	const imagesRef = useRef(attachedImages);
	imagesRef.current = attachedImages;
	const editRevision = useRef(0);

	useLayoutEffect(() => {
		if (!viewReader) return;
		const read = () => thinkingRef.current;
		viewReader.current = read;
		return () => {
			if (viewReader.current === read) viewReader.current = null;
		};
	}, [viewReader]);

	useDictationTarget(
		useCallback((t: string) => {
			const v = joinDictation(thinkingRef.current, t);
			thinkingRef.current = v;
			editRevision.current++;
			setThinking(v);
		}, []),
		true,
	);

	useLayoutEffect(() => {
		viewReader?.changed?.();
	}, [viewReader, thinking]);

	const addFiles = async (files: readonly File[]) => {
		setAttachNotice(null);
		for (const file of files) {
			if (imagesRef.current.length >= 4) {
				setAttachNotice("At most 4 images per submission.");
				break;
			}
			try {
				const normalized = await normalizeImageFile(file);
				const nextImage: ImageContent = {
					type: "image",
					mimeType: normalized.mimeType,
					data: normalized.data,
				};
				setAttachedImages((prev) => {
					const next = prev.length >= 4 ? prev : [...prev, nextImage];
					imagesRef.current = next;
					return next;
				});
			} catch (err) {
				setAttachNotice(err instanceof Error ? err.message : "Could not attach image.");
			}
		}
	};

	const attachScratchpad = async () => {
		setAttachNotice(null);
		if (imagesRef.current.length >= 4) {
			setAttachNotice("At most 4 images per submission.");
			return;
		}
		const snap = await snapshotScratchpadPng(drawingKeyForPath(pathname));
		if (!snap) {
			setAttachNotice("Scratchpad is empty.");
			return;
		}
		setAttachedImages((prev) => {
			const next = [...prev, snap];
			imagesRef.current = next;
			return next;
		});
	};

	const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
		if (customInput) return;
		const files = clipboardImageFiles(e.clipboardData);
		if (files.length === 0) return;
		if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
		void addFiles(files);
	};

	const submit = (action: PracticeThinkingAction = "submit") => {
		if (compactionRunning || preparing) return;
		const imgs = imagesRef.current;

		if (action !== "submit") {
			const text = thinkingRef.current;
			// Hint preserves the learner's text draft so they can keep refining in place.
			if (action !== "hint") {
				thinkingRef.current = "";
				setThinking("");
			}
			if (imgs.length > 0) {
				imagesRef.current = [];
				setAttachedImages([]);
			}
			setAttachNotice(null);
			onSubmit(text, action, imgs.length > 0 ? imgs : undefined);
			return;
		}

		// When there are native attached images and no customInput, pass directly so images reach the turn.
		if (!customInput && imgs.length > 0) {
			const text = thinkingRef.current.trim();
			thinkingRef.current = "";
			setThinking("");
			imagesRef.current = [];
			setAttachedImages([]);
			setAttachNotice(null);
			onSubmit(text, "submit", imgs);
			return;
		}

		const prepare = customInput?.prepare ?? onPrepareSubmission;
		if (prepare) {
			if (customInput ? !customInput.ready : !thinkingRef.current.trim() && !hasPendingInput) return;
			let capturedRevision = editRevision.current;
			prepare(
				() => {
					capturedRevision = editRevision.current;
					return customInput ? thinkingRef.current : thinkingRef.current.trim();
				},
				(captured) => {
					if (
						editRevision.current === capturedRevision &&
						(customInput ? thinkingRef.current : thinkingRef.current.trim()) === captured
					) {
						thinkingRef.current = "";
						setThinking("");
					}
				},
			);
			return;
		}
		const text = thinkingRef.current.trim();
		if (text.length === 0) return;
		thinkingRef.current = "";
		setThinking("");
		setAttachNotice(null);
		onSubmit(text, "submit");
	};

	/* Window-level Enter-from-anywhere only fires while voice dictation is active
	 * so casual typing or reading outside the box never fires a half-written trace. */
	useEnterSubmits(() => {
		if (isDictationActive()) submit("submit");
	}, rootRef);

	/* ── the collapsed bar ── */
	const bar = (
		<button
			type="button"
			data-testid="practice-dock-bar"
			onClick={onExpand}
			className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
		>
			<ChevronRightIcon className="size-4 shrink-0 rotate-90" />
			<span className="font-medium">Problem</span>
			<span className="min-w-0 flex-1 truncate">{input.statement}</span>
		</button>
	);

	const canSubmit = customInput
		? customInput.ready
		: thinking.trim().length > 0 || attachedImages.length > 0 || hasPendingInput;

	/* ── always mount the expanded form (hidden when collapsed) so cursor/draft/images survive scroll ── */
	return (
		<div ref={rootRef} data-testid="practice-dock" data-problem={problemCallId}>
			{!expanded && bar}
			<div hidden={!expanded}>
				{expanded && (
					<div data-dock-scroll-area="" className="max-h-[var(--dock-max-h,40vh)] overflow-y-auto px-4 pt-3 pb-2">
						<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
						<div className="lh-prose text-[15px]">
							<ToolContentResponse>{input.statement}</ToolContentResponse>
						</div>
					</div>
				)}

				{customInput?.editor}

				<div
					data-testid="practice-thinking-field"
					className="m-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
				>
					<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						YOUR THINKING
					</div>

					{attachedImages.length > 0 && (
						<div data-testid="practice-attached-images" className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
							{attachedImages.map((img, idx) => (
								<div key={idx} className="relative">
									{/* eslint-disable-next-line @next/next/no-img-element */}
									<img
										src={imageUrl(img)}
										alt={`Attached scratchwork ${idx + 1}`}
										className="size-14 rounded-lg border bg-muted object-cover"
									/>
									<button
										type="button"
										aria-label="Remove attached image"
										onClick={() =>
											setAttachedImages((prev) => {
												const next = prev.filter((_, i) => i !== idx);
												imagesRef.current = next;
												return next;
											})
										}
										className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground"
									>
										<XIcon className="size-2.5" />
									</button>
								</div>
							))}
						</div>
					)}

					<PathInput
						value={thinking}
						onValueChange={(value) => {
							thinkingRef.current = value;
							editRevision.current++;
							setThinking(value);
						}}
						onPaste={handlePaste}
						onKeyDown={(e) => {
							if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
							if (e.key === "Escape" && onEscape) {
								controller?.claimEscape(e);
								e.preventDefault();
								e.stopPropagation();
								onEscape();
								return;
							}
							if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								submit("submit");
							}
						}}
						placeholder="Work here, think out loud."
						className={cn(
							"field-sizing-content lh-input max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground",
						)}
					/>

					{attachNotice && (
						<p className="px-2.5 pb-1 text-xs text-muted-foreground">{attachNotice}</p>
					)}

					{customInput ? (
						<div className="flex items-center justify-between gap-2 p-1">
							<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
								{compactionRunning ? "compacting session…" : "↵ submits · ⇧↵ newline"}
							</span>
							<Button
								type="button"
								data-testid="practice-send"
								disabled={!canSubmit || compactionRunning || preparing}
								onClick={() => submit("submit")}
								className="ml-auto h-9 rounded-[6px] px-3.5 text-sm font-medium"
							>
								Submit
							</Button>
						</div>
					) : (
						<>
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								multiple
								hidden
								onChange={(e) => {
									const files = Array.from(e.target.files ?? []);
									e.target.value = "";
									if (files.length > 0) void addFiles(files);
								}}
							/>
							<PracticeDockActionBar
								disabled={compactionRunning || preparing}
								onAction={(action) => submit(action)}
								leftSlot={
									<>
										<button
											type="button"
											data-testid="practice-attach-image"
											title="Attach or paste image"
											aria-label="Attach image"
											disabled={compactionRunning || preparing}
											onClick={() => fileInputRef.current?.click()}
											className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
										>
											<PaperclipIcon className="size-3.5" />
										</button>
										<button
											type="button"
											data-testid="practice-attach-scratchpad"
											title="Attach current scratchpad drawing"
											aria-label="Attach scratchpad"
											disabled={compactionRunning || preparing}
											onClick={() => void attachScratchpad()}
											className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
										>
											<PenToolIcon className="size-3.5" />
										</button>
										<span aria-hidden className="hidden pl-1 text-xs text-muted-foreground sm:inline">
											{compactionRunning ? "compacting session…" : "↵ submits · ⇧↵ newline"}
										</span>
									</>
								}
								submitButton={
									<Button
										type="button"
										data-testid="practice-send"
										disabled={!canSubmit || compactionRunning || preparing}
										onClick={() => submit("submit")}
										className="h-9 rounded-[6px] px-3.5 text-sm font-medium"
									>
										Submit thinking
									</Button>
								}
							/>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
