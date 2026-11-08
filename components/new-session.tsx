"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Composer } from "@/components/composer";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { SidebarToggle } from "@/components/sidebar";
import { SetupDialog } from "@/components/setup-dialog";
import { useModelSetup, selectedModelUnavailable, openModelPicker, ZeroKeysPill } from "@/components/setup-cta";
import { StatsBar } from "@/components/stats-bar";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { CAPSTONE_PICK_HINT, ComposerActions, NodePickerControl } from "@/components/composer-actions";
import { ContextAttachControl, useAttachmentDraft, type AttachmentDraft } from "@/components/attachments";
import { useImageDraft, type ImageDraftProps } from "@/components/draft-images";
import { useImageLightbox } from "@/components/image-lightbox";
import { IMAGE_ONLY_TITLE } from "@/src/core";
import { MapIcon, NotebookTextIcon } from "lucide-react";
import { requestReading, useReadingMode } from "@/components/readings/api";
import { OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { SessionStarter } from "@/components/start-session";
import type { ChatSettings, GraphSnapshot } from "@/src/core";

/** The draft's pick set (owner round 10): the SAME shape the home pick
 *  bar lifts — resolved nodes as the learner SAW them at pick time. */
export type DraftPick = { id: string; name: string; statement: string };

/**
 * The sessionless draft view at /chat/new (owner, 2026-09-13): "+ New
 * session" opens THIS, never a created record — a session comes to exist
 * only when the learner sends the first message, and that message becomes
 * the session's title (the exact create-then-redirect contract the home
 * composer established). Visually identical to a fresh chat: same header
 * (title + probe chip), the same empty state, the same composer blob +
 * stats dock. The draft's model control binds the strong slot (the
 * new-session default); the created session is stamped from it
 * server-side (per-session models, owner 2026-09-28).
 */

const DOCK = "mx-auto w-full max-w-[46rem] px-4";

/**
 * Create, safely hand over the full opening text, then return a short
 * /chat/<id> target. Storage/creation failures leave the caller's draft
 * intact. A per-composer starter reuses an already-created session on an
 * unchanged retry. The server stamps settings at birth; no settings PUT.
 */
export async function startDraftSession(
	text: string,
	fetchLike: typeof fetch,
	mode?: "practice" | "capstone",
	picks?: readonly DraftPick[],
	starter = new SessionStarter(),
	settingsIdentity?: string,
	attach?: Parameters<SessionStarter["start"]>[3],
	openingText?: string,
): Promise<string | null> {
	const t = text.trim();
	if (!t && !attach) return null;
	// THE PICKS RIDE THE CREATE (owner round 10): a practice draft seeded
	// from the pick bar creates its session WITH the graph context — the
	// same contract as the home screen's practice send (the marker with
	// [id] name: statement lines, target validation's truth set).
	return starter.start(
		mode
			? { title: t || IMAGE_ONLY_TITLE, kind: mode, ...(picks && picks.length > 0 ? { graphContext: { propositions: picks } } : {}) }
			: { title: t || IMAGE_ONLY_TITLE },
		fetchLike,
		settingsIdentity,
		attach,
		openingText ?? t,
	);
}

/** The pure shell (no router) — the render-test seam: the draft view's
 *  visible surface, assembled from the same pieces a fresh chat shows. */
/* FINISH-FIRST SEND + RUN-END FOCUS live in the shell (it owns the
 * dictation instance); the truth of the text stays in the parent, whose
 * send reads a REF mirror — see NewSession below. */
export function DraftShell({
	busy,
	text,
	onChange,
	onSend,
	startError = false,
	setupCta,
	mode = "teach",
	picks = [],
	onOpenPicker,
	onClearPicks,
	overlay,
	primerAction,
	attachments,
	imageDraft,
}: {
	busy: boolean;
	text: string;
	onChange: (v: string) => void;
	onSend: () => void;
	startError?: boolean;
	/** The practice draft (owner, 2026-10-04): ?mode=practice — the
	 *  created session carries kind:"practice" and the copy changes
	 *  (the practice agent opens; no probing). */
	mode?: "teach" | "practice" | "capstone";
	/** The first-run CTA (fix wave chunk B): the same "Set up your models"
	 *  affordance home carries, rendered above the draft shell — passed by
	 *  NewSession, which owns the configured state and the SetupDialog. */
	setupCta?: ReactNode;
	/** THE PICK BAR (owner round 10): the SAME pill the home screen
	 *  carries above its composer — dashed "Pick nodes" when empty,
	 *  count + Clear when picked. The draft screen has
	 *  no graph behind it, so the picker opens the standalone chain-table
	 *  overlay over fetched snapshot data (owned by NewSession). */
	picks?: DraftPick[];
	onOpenPicker?: () => void;
	onClearPicks?: () => void;
	/** THE PICKER SLOT (owner round 10b): the chain-table overlay hosts
	 *  INSIDE the content column's relative container — the same law as
	 *  the graph view (the overlay fills its column, never the sidebar).
	 *  Passed as a node so the pick state stays in NewSession. */
	overlay?: ReactNode;
	/** Readings (docs/readings.md §6.1): "Primer first" — the key terms of
	 *  the typed topic, as a reading, before starting the session. */
	primerAction?: ReactNode;
	/** Session context attachments: the draft's picked files, uploaded once
	 *  the session exists (NewSession's send). */
	attachments?: AttachmentDraft;
	/** The pasted-image draft (composer paste), parent-held. */
	imageDraft?: ImageDraftProps;
}) {
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of the
	// draft text (via the parent's onChange — the truth lives there); the
	// strip lives in the stats bar's middle slot.
	// Tab navigates INTO the composer (owner, keyboard round 2026-10-06):
	// the only text field on this surface — the cycle's whole chain.
	const cycleComposer = useCallback((): readonly HTMLElement[] =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-testid="composer"] [data-file-path-input]')),
		[]);
	useFieldCycle(cycleComposer);
	const dictation = useDictation({
		append: (t) => onChange(joinDictation(text, t)),
	});
	// A LIVE dictation keeps the composer sendable ("nothing gets lost"
	// round, owner 2026-10-01): the spoken text is deferred in the run's
	// buffer — Enter must reach the finish-first send, not be gated out by
	// an empty textarea. Nothing said → the send no-ops.
	const canSend = (text.trim().length > 0 || dictation.active || Boolean(imageDraft?.hasImages)) && !(mode === "capstone" && picks.length === 0);
	/* FINISH DICTATION FIRST (owner, 2026-10-01): stop the run, let the
	 * last finals land through onChange, THEN call the parent's send —
	 * which reads its REF mirror, so the post-await timing of React's
	 * re-render cannot eat the dictated tail. */
	const handleSend = () => {
		if (dictation.active) {
			void dictation.finish().then(onSend);
			return;
		}
		onSend();
	};
	/* Run end focuses the composer (owner, 2026-10-01): the hands are on
	 * the keyboard from the stop — falling edge of `active` only. */
	const composerInputRef = useRef<HTMLDivElement>(null);
	const dictationWasActiveRef = useRef(false);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			composerInputRef.current?.focus();
		}
	}, [dictation.active]);
	return (
		/* CHROME-LESS CREATION SURFACE (owner round 11, 2026-10-05): the
		 * drafts join home's register — no TopBar, no title (the serif title
		 * always names a session; a draft has none). Home's proven pattern
		 * verbatim: a drag mask first in the DOM, a floating reopen toggle
		 * (the only pointer-events-auto spot), the empty state carrying the
		 * orientation. The chain picker then owns the column top exactly
		 * like the graph view's — no stacked bars. */
		<div className="relative flex h-dvh">
			{/* Window-drag strip — deliberately FIRST in the DOM (the mask
			    law: no-drag subtraction resolves by DOM order, so every
			    carved control later in the tree subtracts correctly). */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="relative flex min-h-0 flex-1">
					{/* The pointer-events pattern (953b22b): the sticky wrapper is
					    pointer-events-none so nothing here blocks the empty-state
					    area; the blob and the stats row re-enable it themselves. */}
					<div className="pointer-events-none sticky bottom-0 mt-auto w-full">
						<Conversation className="h-full min-w-0 flex-1" initial="instant">
							<ConversationContent className="min-h-full gap-0 p-0">
								<ConversationEmptyState
									title={mode === "practice" ? "New practice session" : mode === "capstone" ? "New capstone" : "New session"}
									description={
										mode === "practice"
											? "Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."
											: mode === "capstone"
												? "Pick the nodes you want to build with, then pitch what you would build."
												: "The teacher will open by probing what you already know."
									}
								/>
							</ConversationContent>
						</Conversation>
						<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
						<div className="bg-background pb-4">
							<div className={DOCK}>
								<ComposerActions
									picker={
										<>
											{(picks.length > 0 || mode !== "teach" || primerAction) && (
												<>
													{(picks.length > 0 || mode !== "teach") && (
														<NodePickerControl
															count={picks.length}
															emptyLabel={mode === "capstone" ? CAPSTONE_PICK_HINT : undefined}
															onOpen={onOpenPicker}
															onClear={onClearPicks}
														/>
													)}
													{primerAction}
												</>
											)}
											{attachments && <ContextAttachControl draft={attachments} disabled={busy} />}
										</>
									}
									setup={setupCta}
								/>
								{startError && <p role="alert" className="pointer-events-auto mb-2 text-sm text-destructive">{OPENING_PROMPT_FAILURE}</p>}
								<div data-attachment-composer="" className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
									<Composer
										busy={busy}
										value={text}
										onChange={onChange}
										onSend={handleSend}
										onStop={() => {}}
										canSend={canSend}
										imageDraft={imageDraft}
										inputRef={composerInputRef}
										autoFocus
										onEscape={dictation.active ? dictation.cancel : undefined}
										// The opening question, same as the graph view's new-session
										// input (owner refinement round, 2026-09-24) — no lesson has
										// started yet, so the composer must not read like one is in
										// flight.
										placeholder={mode === "practice" ? "What do you want to practice?" : mode === "capstone" ? "What would you build?" : "What do you want to learn?"}
									/>
								</div>
								<StatsBar
									dictationSlot={<DictationBar dictation={dictation} />}
									turns={[]}
								/>
							</div>
						</div>
					</div>
					{overlay}
				</div>
			</div>
			{/* The floating reopen toggle — pointer-events-none except the
			    toggle itself (home's pattern), painted AFTER the overlay's
			    column so nothing of it blocks the canvas area. */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>
		</div>
	);
}

export function NewSession({ initialConfigured, mode = "teach" }: { initialConfigured: boolean; mode?: "teach" | "practice" | "capstone" }) {
	const router = useRouter();
	const [text, setText] = useState("");
	/* The draft MIRROR ("nothing gets lost" round, 2026-10-01): the shell's
	 * finish-first send calls THIS send after the dictation flush — which
	 * landed via setState and may not have re-rendered yet. The send reads
	 * the mirror; every write keeps it current. */
	const textRef = useRef("");
	const applyText = (v: string) => {
		textRef.current = v;
		setText(v);
	};
	const [busy, setBusy] = useState(false);
	// Readings: the "Primer first" / "Overview first" chips' state (docs/readings.md §6.1).
	const [topicBusy, setTopicBusy] = useState(false);
	const [topicError, setTopicError] = useState<{ kind: "primer" | "overview"; text: string } | null>(null);
	const [readingMode] = useReadingMode();
	const startingRef = useRef(false);
	const starterRef = useRef(new SessionStarter());
	const [startError, setStartError] = useState(false);
	const attachments = useAttachmentDraft();
	const imageDraft = useImageDraft();
	const lightbox = useImageLightbox();
	// THE PICK BAR (owner round 10): the draft's lifted pick set + the
	// snapshot the standalone chain-table picker reads. Lazy — the graph
	// is fetched on FIRST open only, then reused.
	const [picks, setPicks] = useState<DraftPick[]>([]);
	const picksRef = useRef<DraftPick[]>([]);
	const applyPicks = (next: DraftPick[]) => {
		picksRef.current = next;
		setPicks(next);
	};
	const [pickerOpen, setPickerOpen] = useState(false);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const openPicker = () => {
		if (snapshot) {
			setPickerOpen(true);
			return;
		}
		void fetch("/api/graph")
			.then((r) => r.json() as Promise<GraphSnapshot>)
			.then((snap) => {
				setSnapshot(snap);
				setPickerOpen(true);
			})
			.catch(() => {
				/* an unreachable graph leaves the draft usable — pickless */
			});
	};

	// First-run gate (model-slots wave, owner 2026-09-20): the send
	// INTERCEPTS into the setup flow while unconfigured — no defaults for
	// 33 providers, chats cannot start. The draft stays in the textarea;
	// Save stores the slots and never sends (owner ruling 2026-10-09) —
	// the learner sends the draft themselves.
	const { catalog, configured, zeroKeys } = useModelSetup(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);

	const send = useCallback(() => {
		void (async () => {
			await imageDraft.awaitReads(); // a paste followed by Enter must not race its read
			const draft = textRef.current.trim();
			const images = imageDraft.imagesRef.current;
			if ((!draft && images.length === 0 && attachments.files.length === 0) || startingRef.current) return;
			// CAPSTONE: picks are required — nothing is created without them.
			if (mode === "capstone" && picksRef.current.length === 0) return;
			if (!configured) {
				setSetupOpen(true);
				return;
			}
			// The pre-send KEY guards (owner interlude, no-orphan-chats): guard
			// BEFORE startDraftSession creates the record — a refused first
			// send would otherwise leave an orphan error-shell chat in the
			// sidebar. Zero providers opens connection setup; an unavailable
			// selection with another provider opens the ordinary Strong picker.
			// The server's admission gate remains the belt.
			if (zeroKeys) {
				setSetupOpen(true);
				return;
			}
			const strong = catalog?.slots.strong?.model;
			if (selectedModelUnavailable(catalog, strong ? `${strong.provider}:${strong.id}` : undefined)) {
				openModelPicker();
				return; // The learner replaces it explicitly, then sends again.
			}
			startingRef.current = true;
			setBusy(true);
			setStartError(false);
			const attach = attachments.files.length > 0 || images.length > 0
				? {
						identity: `${attachments.identity()}|${images.map((i) => i.id).join("|")}`,
						upload: async (chatId: string) => {
							const fileIds = attachments.files.length > 0 ? await attachments.upload(chatId) : [];
							const imageIds = images.length > 0 ? (await imageDraft.upload(chatId)).map((r) => r.record.id) : [];
							return [...fileIds, ...imageIds];
						},
					}
				: undefined;
			void startDraftSession(draft, fetch, mode === "teach" ? undefined : mode, mode === "teach" ? undefined : picksRef.current,
				starterRef.current, JSON.stringify(catalog?.slots.strong), attach, draft)
				.then((target) => {
					if (target) router.push(target);
					else { startingRef.current = false; setBusy(false); }
				})
				.catch(() => {
					startingRef.current = false;
					setBusy(false);
					setStartError(true);
				});
		})();
	}, [router, configured, zeroKeys, catalog, mode, attachments, imageDraft]);

	return (
		<>
			<DraftShell
				busy={busy}
				startError={startError}
				text={text}
				onChange={applyText}
				onSend={send}
				mode={mode}
				picks={picks}
				onOpenPicker={openPicker}
				onClearPicks={() => applyPicks([])}
				attachments={attachments}
				imageDraft={{ ...imageDraft.props, onOpen: lightbox.open }}
				primerAction={
					mode === "teach" && text.trim().length > 0 ? (
						<>
							{(
								[
									["primer", "primer-first", "Primer first", NotebookTextIcon, "Write a primer of this topic's key terms first — the session waits until you start it"],
									["overview", "overview-first", "Overview first", MapIcon, "Write an overview of this whole topic first — the session waits until you start it"],
								] as const
							).map(([kind, testId, label, Icon, title]) => (
								<button
									key={kind}
									type="button"
									data-testid={testId}
									disabled={topicBusy}
									title={title}
									onClick={async () => {
										if (!configured) {
											setSetupOpen(true);
											return;
										}
										setTopicBusy(true);
										setTopicError(null);
										const res = await requestReading({ kind, topic: textRef.current.trim(), mode: readingMode });
										setTopicBusy(false);
										if (!res.ok) return setTopicError({ kind, text: res.error });
										router.push(`/readings/${res.id}`);
									}}
									className="flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border/80 px-3 py-1.5 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
								>
									<Icon aria-hidden="true" className="size-3.5" />
									{topicError?.kind === kind ? topicError.text : label}
								</button>
							))}
						</>
					) : undefined
				}
				overlay={
					// THE PICKER (owner round 10b): hosted INSIDE the content
					// column — absolute inset-0 resolves to the column's relative
					// container, the same confinement the graph view gives it;
					// never over the sidebar or the traffic lights.
					<ChainTableOverlay
						open={pickerOpen}
						nodes={snapshot?.propositions ?? []}
						chains={snapshot?.chains ?? []}
						sessions={snapshot?.sessions ?? {}}
						fileSources={snapshot?.fileSources ?? {}}
						onClose={() => setPickerOpen(false)}
						selectMode
						controlledSelection={new Set(picks.map((p) => p.id))}
						onSelectionChange={(ids) => {
							const byId = new Map((snapshot?.propositions ?? []).map((n) => [n.id, n]));
							const next: DraftPick[] = [];
							for (const id of ids) {
								const n = byId.get(id);
								if (n) next.push({ id: n.id, name: n.name, statement: n.statement });
							}
							applyPicks(next);
						}}
					/>
				}
				setupCta={
					zeroKeys ? (
						<ZeroKeysPill inline onOpen={() => setSetupOpen(true)} />
					) : (
						!configured && (
							<button
								type="button"
								data-testid="setup-cta"
								onClick={() => setSetupOpen(true)}
								className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
							>
								Set up your models
							</button>
						)
					)
				}
			/>
			{/* The pasted picture at full size (composer paste): a session-scoped
			    overlay over the draft column, the same shell the session uses. */}
			{lightbox.lightbox}
			{/* First-run setup: the send interception's landing surface — stage
			    1 is the self-contained first-key screen (zero-keys wave). */}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setSetupOpen(false);
					// Save only saves (owner ruling 2026-10-09): the draft
					// waits in the composer; the learner sends it.
				}}
				/>
		</>
	);
}