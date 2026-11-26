"use client";

import { CheckSquareIcon, ShieldCheckIcon } from "lucide-react";
import {
	PRACTICE_COACHING_LEVELS,
	PRACTICE_DEPTHS,
	PRACTICE_PRESENTATIONS,
	type PracticeCoachingLevel,
	type PracticeDepth,
	type PracticePresentation,
	type PracticeSessionMeta,
} from "@/src/core";
import { cn } from "@/lib/utils";

const COACHING_LABELS: Record<PracticeCoachingLevel, { label: string; title: string }> = {
	socratic: { label: "Socratic", title: "Strict tiny hints; never auto-ends on failure" },
	balanced: { label: "Balanced", title: "Escalates smoothly; offers reveal or step-down after 2–3 stuck tries" },
	direct: { label: "Direct", title: "Immediate correction and solution reveal after a miss" },
};

const DEPTH_LABELS: Record<PracticeDepth, { label: string; title: string }> = {
	recall: { label: "Quick", title: "Fast 1–2 decision-point recall and discrimination checks" },
	adaptive: { label: "Adaptive", title: "Warm-up, interleaving, and difficulty stepping" },
	deep: { label: "Deep", title: "Rich multi-step composition, derivations, and code challenges" },
};

const PRESENTATION_LABELS: Record<PracticePresentation, { label: string; title: string }> = {
	auto: { label: "Auto", title: "Vary between abstract theory and concrete applied framing" },
	theory: { label: "Theory", title: "Formal and conceptual problem framing" },
	applied: { label: "Applied", title: "Concrete scenarios, calculations, and debugging" },
};

function SegmentedDial<T extends string>({
	testIdPrefix,
	ariaLabel,
	options,
	value,
	labels,
	disabled,
	onChange,
}: {
	testIdPrefix: string;
	ariaLabel: string;
	options: readonly T[];
	value: T;
	labels: Record<T, { label: string; title: string }>;
	disabled?: boolean;
	onChange: (next: T) => void;
}) {
	return (
		<div
			role="group"
			aria-label={ariaLabel}
			className="flex items-center rounded-md border border-border/70 bg-background/60 p-0.5"
		>
			{options.map((opt) => {
				const active = value === opt;
				return (
					<button
						key={opt}
						type="button"
						data-testid={`${testIdPrefix}-${opt}`}
						aria-pressed={active}
						title={labels[opt].title}
						disabled={disabled}
						onClick={() => {
							if (!active) onChange(opt);
						}}
						className={cn(
							"cursor-pointer rounded-[4px] px-2 py-0.5 font-ui text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
							active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{labels[opt].label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * Compact Practice v2 session controls mounted below/inside the session header:
 * Coaching · Depth · Style · Verify toggle · Wrap up.
 */
export function PracticeToolbar({
	meta,
	onChange,
	onWrapUp,
	wrapUpDisabled,
	disabled,
}: {
	meta: PracticeSessionMeta;
	onChange: (patch: Partial<PracticeSessionMeta>) => void;
	onWrapUp: () => void;
	wrapUpDisabled?: boolean;
	disabled?: boolean;
}) {
	return (
		<div
			data-testid="practice-toolbar"
			className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/95 px-4 py-1.5 backdrop-blur"
		>
			<div className="mx-auto flex w-full max-w-[46rem] flex-wrap items-center gap-2">
				<SegmentedDial
					testIdPrefix="practice-dial-coaching"
					ariaLabel="Coaching level"
					options={PRACTICE_COACHING_LEVELS}
					value={meta.coaching}
					labels={COACHING_LABELS}
					disabled={disabled}
					onChange={(coaching) => onChange({ coaching })}
				/>
				<SegmentedDial
					testIdPrefix="practice-dial-depth"
					ariaLabel="Difficulty and depth"
					options={PRACTICE_DEPTHS}
					value={meta.depth}
					labels={DEPTH_LABELS}
					disabled={disabled}
					onChange={(depth) => onChange({ depth })}
				/>
				<SegmentedDial
					testIdPrefix="practice-dial-style"
					ariaLabel="Presentation style"
					options={PRACTICE_PRESENTATIONS}
					value={meta.presentation}
					labels={PRESENTATION_LABELS}
					disabled={disabled}
					onChange={(presentation) => onChange({ presentation })}
				/>
				<button
					type="button"
					data-testid="practice-dial-verify"
					aria-pressed={meta.verifySolutions}
					disabled={disabled}
					title="Sanity-check posed problems with your Cheap model before displaying them"
					onClick={() => onChange({ verifySolutions: !meta.verifySolutions })}
					className={cn(
						"flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 font-ui text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
						meta.verifySolutions
							? "border-primary/50 bg-primary/10 text-foreground"
							: "border-border/70 text-muted-foreground hover:text-foreground",
					)}
				>
					<ShieldCheckIcon className="size-3.5" aria-hidden />
					Verify
				</button>
				<button
					type="button"
					data-testid="practice-wrap-up"
					disabled={wrapUpDisabled}
					title={wrapUpDisabled ? "Conclude the active problem and wait for the turn to finish before wrapping up" : "Generate a session recap and remedial Teach recommendations"}
					onClick={onWrapUp}
					className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 bg-card px-2.5 py-0.5 font-ui text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
				>
					<CheckSquareIcon className="size-3.5 text-primary" aria-hidden />
					Wrap up
				</button>
			</div>
		</div>
	);
}

/** Compact initial dial selector shown on /chat/new?mode=practice above the draft composer. */
export function PracticeDraftDials({
	meta,
	onChange,
	disabled,
}: {
	meta: PracticeSessionMeta;
	onChange: (next: PracticeSessionMeta) => void;
	disabled?: boolean;
}) {
	return (
		<div
			data-testid="practice-draft-dials"
			className="pointer-events-auto mb-2 flex flex-wrap items-center gap-1.5"
		>
			<SegmentedDial
				testIdPrefix="practice-draft-coaching"
				ariaLabel="Coaching level"
				options={PRACTICE_COACHING_LEVELS}
				value={meta.coaching}
				labels={COACHING_LABELS}
				disabled={disabled}
				onChange={(coaching) => onChange({ ...meta, coaching })}
			/>
			<SegmentedDial
				testIdPrefix="practice-draft-depth"
				ariaLabel="Difficulty and depth"
				options={PRACTICE_DEPTHS}
				value={meta.depth}
				labels={DEPTH_LABELS}
				disabled={disabled}
				onChange={(depth) => onChange({ ...meta, depth })}
			/>
			<SegmentedDial
				testIdPrefix="practice-draft-style"
				ariaLabel="Presentation style"
				options={PRACTICE_PRESENTATIONS}
				value={meta.presentation}
				labels={PRESENTATION_LABELS}
				disabled={disabled}
				onChange={(presentation) => onChange({ ...meta, presentation })}
			/>
			<button
				type="button"
				data-testid="practice-draft-verify"
				aria-pressed={meta.verifySolutions}
				disabled={disabled}
				title="Sanity-check posed problems with your Cheap model before displaying them"
				onClick={() => onChange({ ...meta, verifySolutions: !meta.verifySolutions })}
				className={cn(
					"flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 font-ui text-[11px] font-medium transition-colors disabled:opacity-50",
					meta.verifySolutions
						? "border-primary/50 bg-primary/10 text-foreground"
						: "border-border/70 bg-background/60 text-muted-foreground hover:text-foreground",
				)}
			>
				<ShieldCheckIcon className="size-3.5" aria-hidden />
				Verify
			</button>
		</div>
	);
}
