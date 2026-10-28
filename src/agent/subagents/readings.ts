/**
 * THE READINGS PIPELINE (docs/readings.md §5): the writer sub-agent and
 * its run registry. Learner-requested, background, never chat-woken.
 *
 * NOT a Workbench job (architecture §7's practice-run reasoning): teacher
 * jobs are bound to a teacher tool call and deliver by a steer that WAKES
 * the teacher. A reading is learner-requested and not lesson content —
 * finishing one must never interrupt a lesson. So readings run in their
 * own globalThis registry (one row per reading, its own abort controller
 * and usage accumulation, surfaced in the activity dock), under the
 * shared background-LLM semaphore, and persist only to their own store.
 *
 * The writer: one runSubmitAgent loop — the researcher's web toolset in
 * researched mode (none in model mode) plus a single `submit_reading`
 * call whose validate hook enforces the CITATION LAW (every cited URL was
 * successfully fetched in this run) and the per-kind shape. Dependencies
 * arrive by injection (the agent layer never imports server/store).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelRole } from "../../../config.ts";
import { PATHS } from "../../../config.ts";
import { emit } from "../../core/events.ts";
import type { ReadingStore } from "../../core/ports.ts";
import type { SearchProvider } from "../../core/search.ts";
import {
	accumulateJobUsage,
	piUsageToStep,
	type FurtherReadingItem,
	type GlossaryTerm,
	type JobUsage,
	type OverviewSection,
	type ReadingKind,
	type ReadingMode,
	type ReadingRecord,
	type ReadingSource,
} from "../../core/contracts.ts";
import { citationProblems, fetchSucceeded, normalizeUrl, urlsInText } from "../../core/readings.ts";
import { modelsNotConfigured, ROLE_SLOT, type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import { createWebTools } from "../tools/web.ts";
import { createPdfReadTools } from "../tools/pdf-read.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";

// ─── prompt composition ─────────────────────────────────────────────────────

const READINGS_PROMPTS = path.join(PATHS.root, "src", "agent", "prompts", "readings");
const SHARED_PROMPTS = path.join(PATHS.root, "src", "agent", "prompts", "shared");
/** The shared law every learner-facing agent composes: voice, accuracy,
 *  formatting (the practice agent's curated set, minus the thinking-field
 *  doctrine — readings have no thinking fields). */
const SHARED_FRAGMENTS = ["10-voice.md", "15-accuracy.md", "40-formatting.md"];

function readPrompt(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8").trim();
	} catch {
		return "";
	}
}

/** base → source mode → kind → shared appendix. Node readings share the
 *  deep-dive's shape with their own task file. */
export function composeWriterPrompt(kind: ReadingKind, mode: ReadingMode): string {
	return [
		readPrompt(path.join(READINGS_PROMPTS, "00-base.md")),
		readPrompt(path.join(READINGS_PROMPTS, `05-${mode}.md`)),
		readPrompt(path.join(READINGS_PROMPTS, `10-${kind}.md`)),
		...SHARED_FRAGMENTS.map((f) => readPrompt(path.join(SHARED_PROMPTS, f))),
	]
		.filter(Boolean)
		.join("\n\n---\n\n");
}

/** The writer's task text: the frozen snapshot, sectioned. Pure. */
export function writerTaskText(r: Pick<ReadingRecord, "kind" | "mode" | "request" | "anchor" | "snapshot" | "title">): string {
	const s = r.snapshot;
	const out: string[] = [];
	const kindLine: Record<ReadingKind, string> = {
		primer: "Write a PRIMER: the key terms of this lesson, as definitions.",
		overview: "Write an OVERVIEW: the map of this whole topic, section by section.",
		"deep-dive": "Write a DEEP DIVE on the focus below.",
		recap: "Write a RECAP of this session.",
		node: "Write a DEEP DIVE on the propositions below, from his knowledge map.",
	};
	out.push(`# Task\n\n${kindLine[r.kind]} Source mode: ${r.mode === "researched" ? "researched (use the web tools; cite only what you fetched)" : "model knowledge only (no sources)"}.`);
	if (r.request) out.push(`# His request\n\n${r.request}`);
	if (r.anchor.topic) out.push(`# Topic (no session yet)\n\n${r.anchor.topic}`);
	if (s.sessionTitle) out.push(`# Session\n\n${s.sessionTitle}`);
	if (s.focus) out.push(`# Focus — the plan node\n\n${s.focus.title}${s.focus.summary ? ` — ${s.focus.summary}` : ""}`);
	if (r.anchor.passage) out.push(`# Focus — the passage he selected\n\n> ${r.anchor.passage.replace(/\n/g, "\n> ")}`);
	if (s.upcoming && s.upcoming.length > 0) {
		out.push(`# Not yet reached in his lesson (name only — never explain)\n\n${s.upcoming.map((t) => `- ${t}`).join("\n")}`);
	}
	if (s.assessment) out.push(`# The probe's read of where he stands\n\n${s.assessment}`);
	if (s.plan) out.push(`# The lesson plan (statuses: visited / current / upcoming)\n\n${s.plan}`);
	if (s.planNodes && s.planNodes.length > 0) {
		out.push(`# Plan nodes a section may tag (planNodeIds — exact ids only)\n\n${s.planNodes.map((n) => `- \`${n.id}\` — ${n.title}`).join("\n")}`);
	}
	if (s.propositions && s.propositions.length > 0) {
		out.push(
			`# Propositions${r.kind === "recap" ? " extracted from this session" : ""}\n\n${s.propositions.map((p) => `- **${p.name}** — ${p.statement}`).join("\n")}`,
		);
	}
	if (s.chains && s.chains.length > 0) out.push(`# Reasoning chains among them (premises ⟹ conclusion)\n\n${s.chains.map((c) => `- ${c}`).join("\n")}`);
	if (s.transcript) {
		out.push(
			`# The session transcript${s.transcriptTrimmed ? " (trimmed: the opening and the most recent stretch)" : ""}\n\n<transcript>\n${s.transcript}\n</transcript>`,
		);
	}
	out.push("Finish with one submit_reading call.");
	return out.join("\n\n");
}

// ─── the submit schema + per-kind validation ────────────────────────────────

const sourceSchema = Type.Object({
	title: Type.String({ description: "The source's title" }),
	url: Type.String({ description: "The exact URL you fetched" }),
});

export const submitReadingSchema = Type.Object({
	title: Type.String({ description: "Short, specific title (a heading, not a sentence)." }),
	body: Type.String({ description: "The whole reading in markdown (no title heading at the top). Primers and overviews: a short intro only." }),
	terms: Type.Optional(
		Type.Array(
			Type.Object({
				term: Type.String(),
				definition: Type.String({ description: "A real definition, 1-3 sentences, LaTeX for notation." }),
			}),
			{ description: "PRIMERS ONLY: the glossary, in dependency order." },
		),
	),
	sections: Type.Optional(
		Type.Array(
			Type.Object({
				heading: Type.String({ description: "The section's heading." }),
				body: Type.String({ description: "The section in markdown (no heading at the top)." }),
				planNodeIds: Type.Optional(
					Type.Array(Type.String(), { description: "Ids of the lesson-plan nodes this section maps to — from the given list only; empty when none." }),
				),
			}),
			{ description: "OVERVIEWS ONLY: the article, in reading order." },
		),
	),
	sources: Type.Optional(Type.Array(sourceSchema, { description: "Researched mode: every source the body relies on — fetched pages only." })),
	furtherReading: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String(),
				url: Type.String({ description: "The exact URL you fetched" }),
				why: Type.String({ description: "One sentence: what it adds from where the session left off." }),
				level: Type.Optional(Type.Union([Type.Literal("intro"), Type.Literal("standard"), Type.Literal("advanced")])),
			}),
			{ description: "RECAPS ONLY, researched mode: 3-8 fetched sources, closest first." },
		),
	),
});

export interface SubmittedReading {
	title: string;
	body: string;
	terms: GlossaryTerm[];
	sections: OverviewSection[];
	sources: ReadingSource[];
	furtherReading: FurtherReadingItem[];
}

/** The per-kind + citation validation (the submit seam's `validate`).
 *  Pure — exported for tests. null = accept. */
export function submittedReadingProblem(
	kind: ReadingKind,
	mode: ReadingMode,
	value: SubmittedReading,
	fetched: ReadonlySet<string>,
	/** Overviews: the plan-node ids a section may tag (none = no plan). */
	planNodeIds: ReadonlySet<string> = new Set(),
): string | null {
	const problems: string[] = [];
	if (!value.title.trim()) problems.push("title is empty");
	if (kind === "primer") {
		if (value.terms.length < 3) problems.push("a primer needs `terms`: at least 3 glossary entries");
		if (value.terms.some((t) => !t.term.trim() || !t.definition.trim())) problems.push("every term needs a term and a definition");
	} else if (kind === "overview") {
		if (value.terms.length > 0) problems.push("`terms` is for primers only — put the content in `sections`");
		if (value.sections.length < 2) problems.push("an overview needs `sections`: at least 2, in reading order");
		if (value.sections.some((sec) => !sec.heading.trim() || !sec.body.trim())) problems.push("every section needs a heading and a body");
		const unknown = [...new Set(value.sections.flatMap((sec) => sec.planNodeIds ?? []).filter((id) => !planNodeIds.has(id)))];
		if (unknown.length > 0) {
			problems.push(
				planNodeIds.size === 0
					? "There is no lesson plan: every section's `planNodeIds` must be empty."
					: `Unknown plan node ids in planNodeIds: ${unknown.join(", ")} — use only ids from the given plan-node list.`,
			);
		}
		if (value.body.trim().length + value.sections.reduce((n, sec) => n + sec.body.trim().length, 0) < 200) {
			problems.push("the overview is too short to be a reading");
		}
	} else {
		if (value.terms.length > 0) problems.push("`terms` is for primers only — put the content in `body`");
		if (value.body.trim().length < 200) problems.push("the body is too short to be a reading");
	}
	if (kind !== "overview" && value.sections.length > 0) problems.push("`sections` is for overviews only — put the content in `body`");
	if (kind !== "recap" && value.furtherReading.length > 0) problems.push("`furtherReading` is for recaps only — cite sources in `sources`");
	if (kind === "recap" && mode === "researched" && value.furtherReading.length === 0) {
		problems.push("a researched recap needs `furtherReading`: 3-8 sources you fetched, closest to the session first");
	}
	problems.push(...citationProblems([...value.sources, ...value.furtherReading], fetched, mode));
	// Links written into the text are citations too (the law has no side door).
	const inline = urlsInText([value.body, ...value.terms.map((t) => t.definition), ...value.sections.map((sec) => sec.body)].join("\n"));
	if (mode === "model" && inline.length > 0) {
		problems.push("Model-knowledge mode: the text must contain no URLs (no web access was used) — remove the links.");
	} else if (mode === "researched") {
		problems.push(...citationProblems(inline.map((url) => ({ url })), fetched, mode));
	}
	return problems.length > 0 ? problems.join("\n") : null;
}

// ─── the run registry ───────────────────────────────────────────────────────

export interface RunningReading {
	id: string;
	title: string;
	chatId?: string;
	startedAt: number;
	activity: string;
}

interface LhReadingsGlobal {
	__lhReadingRuns?: Map<string, { controller: AbortController; row: RunningReading }>;
	__lhReadingsSwept?: boolean;
}

function runs(): NonNullable<LhReadingsGlobal["__lhReadingRuns"]> {
	const g = globalThis as typeof globalThis & LhReadingsGlobal;
	return (g.__lhReadingRuns ??= new Map());
}

/** The dock's rows: every reading being written, oldest first. */
export function readingRunStatuses(): RunningReading[] {
	return [...runs().values()].map((r) => ({ ...r.row })).sort((a, b) => a.startedAt - b.startedAt);
}

/** Is a run for this reading live in this process? */
export function readingRunLive(id: string): boolean {
	return runs().has(id);
}

// ─── the pipeline ───────────────────────────────────────────────────────────

export interface ReadingsPipelineDeps {
	readingStore: ReadingStore;
	/** The writer engine, settings-resolved per run. undefined = refused. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** Test seam: a scripted engine wins over engineFor. */
	engine?: PiEngine;
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
	searchProvider?: () => SearchProvider | null;
	/** Turn caps (tests shrink them). */
	maxTurns?: { researched: number; model: number };
}

export interface ReadingsPipeline {
	/** Fire-and-forget: run a queued reading to a terminal state. */
	start(id: string): void;
	/** Awaitable run (tests, and start's body). Never throws. */
	run(id: string): Promise<void>;
	/** Stop a live run. The record settles as error "Stopped". */
	abort(id: string): boolean;
	/** Refusal check before creating a record: the writer's model/key
	 *  chain. null = OK; else the envelope's human error line. */
	refusal(): string | null;
	/** Orphan sweep: records left queued/writing by a dead process. */
	sweep(): number;
	/** One record's orphan check (the GET path). */
	settleIfOrphaned(r: ReadingRecord): ReadingRecord;
}

const STOPPED = "Stopped";
/** A live run touches its record this often; a record untouched for
 *  STALE_MS while queued/writing has no live writer anywhere. */
const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;

export function createReadingsPipeline(deps: ReadingsPipelineDeps): ReadingsPipeline {
	const { readingStore } = deps;
	const caps = deps.maxTurns ?? { researched: 28, model: 3 };

	function engine(): PiEngine | undefined {
		return deps.engine ?? deps.engineFor?.("writer");
	}

	function refusal(): string | null {
		const e = engine();
		if (!e) return modelsNotConfigured([ROLE_SLOT.writer]).error;
		const key = deps.providerKeyMissing?.(e.model.provider, ROLE_SLOT.writer) ?? null;
		return key ? key.error : null;
	}

	function setActivity(id: string, line: string): void {
		const run = runs().get(id);
		if (run) run.row.activity = line;
		readingStore.updateReading(id, { activity: line });
		emit("activity-changed", {});
	}

	async function run(id: string): Promise<void> {
		const record = readingStore.getReading(id);
		if (!record || record.status !== "queued") return;
		if (runs().has(id)) return;
		const controller = new AbortController();
		runs().set(id, {
			controller,
			row: { id, title: record.title, chatId: record.anchor.chatId, startedAt: Date.now(), activity: "queued" },
		});
		emit("activity-changed", {});
		let pdfDir: string | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		try {
			const refused = refusal();
			if (refused) {
				readingStore.updateReading(id, { status: "error", error: refused, activity: undefined });
				return;
			}
			const e = engine()!;
			readingStore.updateReading(id, { status: "writing", activity: "waiting for a model slot" });
			// Heartbeat: a live run keeps its record fresh even through a long
			// model call, so the stale-sweep only ever catches orphans.
			heartbeat = setInterval(() => readingStore.updateReading(id, {}), HEARTBEAT_MS);
			await withBgLlmSlot(controller.signal, async () => {
				const fetched = new Set<string>();
				const extraTools: Record<string, AgentTool<any>> = {};
				if (record.mode === "researched") {
					pdfDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lh-reading-"));
					const raw = {
						...createWebTools(deps.searchProvider ?? (() => null)),
						...createPdfReadTools(pdfDir),
					};
					for (const [name, tool] of Object.entries(raw)) extraTools[name] = instrument(id, tool, fetched);
				}
				setActivity(id, record.mode === "researched" ? "researching" : "writing");
				let usage: JobUsage | undefined = record.usage;
				const submitted = await runSubmitAgent<SubmittedReading>({
					role: "writer",
					toolName: "submit_reading",
					toolDescription:
						"Submit the finished reading — exactly once, at the end. Fields per kind are described on each field; " +
						"the call is validated (citations must be pages you fetched) and returns problems to fix if it fails.",
					parameters: submitReadingSchema,
					fill: (input: Record<string, unknown>) => ({
						title: String(input.title ?? "").trim(),
						body: String(input.body ?? "").trim(),
						terms: Array.isArray(input.terms) ? (input.terms as GlossaryTerm[]) : [],
						sections: Array.isArray(input.sections) ? (input.sections as OverviewSection[]) : [],
						sources: Array.isArray(input.sources) ? (input.sources as ReadingSource[]) : [],
						furtherReading: Array.isArray(input.furtherReading) ? (input.furtherReading as FurtherReadingItem[]) : [],
					}),
					validate: (value) =>
						submittedReadingProblem(record.kind, record.mode, value, fetched, new Set((record.snapshot.planNodes ?? []).map((n) => n.id))),
					systemPrompt: composeWriterPrompt(record.kind, record.mode),
					prompt: writerTaskText(record),
					engine: e,
					signal: controller.signal,
					extraTools,
					maxTurns: record.mode === "researched" ? caps.researched : caps.model,
					onStep: (u, model) => {
						usage = accumulateJobUsage(usage, model, piUsageToStep(u));
						readingStore.updateReading(id, { usage });
					},
					neverSubmitted: "The writer finished without submitting a reading.",
				});
				readingStore.updateReading(id, {
					status: "ready",
					title: submitted.title || record.title,
					body: submitted.body,
					...(submitted.terms.length > 0 ? { terms: submitted.terms } : {}),
					...(submitted.sections.length > 0 ? { sections: submitted.sections.map(cleanSection) } : {}),
					...(submitted.sources.length > 0 ? { sources: dedupeSources(submitted.sources) } : {}),
					...(submitted.furtherReading.length > 0 ? { furtherReading: dedupeSources(submitted.furtherReading) } : {}),
					activity: undefined,
					error: undefined,
				});
			});
		} catch (err) {
			const aborted = controller.signal.aborted;
			const reason = aborted ? STOPPED : err instanceof Error ? err.message : String(err);
			if (!aborted) console.error(`[reading ${id}] failed:`, err);
			readingStore.updateReading(id, { status: "error", error: reason, activity: undefined });
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			runs().delete(id);
			emit("activity-changed", {});
			if (pdfDir) await fsp.rm(pdfDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Wrap a web/pdf tool: record successful fetches (the citation law's
	 *  truth set) and surface each call as the row's activity line. */
	function instrument(id: string, tool: AgentTool<any>, fetched: Set<string>): AgentTool<any> {
		return {
			...tool,
			execute: async (callId, input, signal, onUpdate) => {
				const args = input as { url?: string; query?: string; path?: string };
				const what = args.url ?? args.query ?? args.path ?? "";
				setActivity(id, `${tool.name}${what ? `: ${what.length > 80 ? `${what.slice(0, 79)}…` : what}` : ""}`);
				const result = await tool.execute(callId, input, signal, onUpdate);
				if ((tool.name === "web_fetch" || tool.name === "web_fetch_pdf") && typeof args.url === "string") {
					const text = (result.content ?? [])
						.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
						.map((c) => c.text)
						.join("");
					if (fetchSucceeded(tool.name, text)) fetched.add(normalizeUrl(args.url));
				}
				return result;
			},
		};
	}

	/** A queued/writing record with no live run here AND no heartbeat for
	 *  STALE_MS is an orphan (a sibling dev worker's live run heartbeats). */
	function settle(r: ReadingRecord): ReadingRecord {
		if (r.status !== "queued" && r.status !== "writing") return r;
		if (runs().has(r.id) || Date.now() - Date.parse(r.updatedAt) < STALE_MS) return r;
		return readingStore.updateReading(r.id, { status: "error", error: "Interrupted (server restarted)", activity: undefined }) ?? r;
	}

	return {
		start(id) {
			void run(id);
		},
		run,
		abort(id) {
			const live = runs().get(id);
			if (!live) return false;
			live.controller.abort();
			return true;
		},
		refusal,
		sweep() {
			let n = 0;
			for (const r of readingStore.listReadings()) {
				if (settle(r) !== r) n++;
			}
			return n;
		},
		settleIfOrphaned: settle,
	};
}

/** A section as stored: trimmed, node ids deduped, empty tag lists dropped. */
function cleanSection(sec: OverviewSection): OverviewSection {
	const ids = [...new Set(sec.planNodeIds ?? [])];
	return { heading: sec.heading.trim(), body: sec.body.trim(), ...(ids.length > 0 ? { planNodeIds: ids } : {}) };
}

function dedupeSources<T extends ReadingSource>(list: T[]): T[] {
	const seen = new Set<string>();
	return list.filter((s) => {
		const k = normalizeUrl(s.url);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}
