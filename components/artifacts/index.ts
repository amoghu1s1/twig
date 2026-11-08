import type { ComponentType } from "react";
import type { ArtifactPartProps } from "@/src/core";
import { DemoCard } from "@/components/artifacts/demo-card";
import { JobCard, PdfJobCard } from "@/components/artifacts/job-card";
import { VisualCard } from "@/components/artifacts/visual-card";
import { ImageCard } from "@/components/artifacts/image-card";
import { ProbeDoneCard } from "@/components/artifacts/probe-done-card";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { ProblemCard, ConcludeCard } from "@/components/practice-cards";
import { BriefCard, ReviewCard, EvaluateCard, GapReportCard } from "@/components/capstone-cards";
import { ReadingOfferCard } from "@/components/readings/offer-card";

/**
 * Artifact renderer registry — the extension point for tool-part UI.
 *
 * chat.tsx renders any tool part it doesn't specially handle (i.e. not
 * quiz/ask) by looking the tool name up here. Add your renderer — do NOT
 * edit chat.tsx (see docs/archive/plan.md file-ownership rules).
 *
 * Typical shape: while the part is input-available render an activity card
 * (the chat view's jobs feed reads GET /api/jobs?chatId=…; on completion call
 * ChatActionsContext.syncFromServer()); when output-available render the
 * artifact itself from part.output.
 */
export const artifactRenderers: Record<string, ComponentType<ArtifactPartProps>> = {
	research: JobCard,
	pdf: PdfJobCard, // sources v0 — live smoke 2026-09-19 caught the gap: without this the tool-pdf dispatch part rendered nothing
	// plan_* parts render nothing inline by design: the phase seam is a
	// message-level boundary, drawn by PhaseDivider in chat.tsx (the old
	// part-level plan_init divider retired with it).
	// Artifacts (W6 fills in the components):
	demo: DemoCard,
	visual: VisualCard,
	// A learner image shown as-is (issue #363): the picture itself, inline.
	show_image: ImageCard,
	// The probe conclusion: the assessment belongs to the learner as much as
	// to the transcript (docs/archive/probe-teach-split.md §2). Plain v1 card.
	probe_done: ProbeDoneCard,
	// The learner-filesystem set (sources v1): one quiet expandable
	// tool-call card each — collapsed one-liner (tool name + headline
	// argument), full input/output on expand.
	read: ToolCallCard,
	pdf_view: ToolCallCard,
	ls: ToolCallCard,
	find: ToolCallCard,
	grep: ToolCallCard,
	// The practice pair (2026-10-04): the pose renders the statement ONLY
	// (the commitment lives in the call's arguments and never renders);
	// the conclusion carries the outcome + verdict + the reveal.
	problem: ProblemCard,
	conclude: ConcludeCard,
	// The capstone set (2026-11-01): the accepted brief, checkpoint reviews,
	// evaluations and the no-pitch gap report. The scoped read/ls/find/grep
	// reuse the quiet tool-call cards registered above.
	brief: BriefCard,
	review: ReviewCard,
	evaluate: EvaluateCard,
	gap_report: GapReportCard,
	// The prober's graph tools (wave 7): same quiet expandable card —
	// collapsed one-liner (tool name + the session id for
	// list_propositions), the tool's own compact row-per-line output
	// (name / level / date) verbatim on expand, exactly the read/ls
	// discipline (their results are pre-formatted strings too).
	list_sessions: ToolCallCard,
	list_propositions: ToolCallCard,
	// Readings (docs/readings.md §6.2): the teacher's OFFER — a card the
	// learner may click to opt in; nothing is written until he does.
	suggest_reading: ReadingOfferCard,
};
