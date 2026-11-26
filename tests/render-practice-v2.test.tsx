import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_PRACTICE_META, newGraphContextMessage, newMessageId, type LhMessage } from "@/src/core";
import { PracticeToolbar, PracticeDraftDials } from "@/components/practice-toolbar";
import { PracticeProgressStrip } from "@/components/practice-progress-strip";
import { PracticeDock } from "@/components/practice-dock";
import { PracticeCheckDock } from "@/components/practice-check-dock";
import { PracticeMatchDock } from "@/components/practice-match-dock";
import { PracticeCodeDock } from "@/components/practice-code-dock";
import { PracticeSummaryCard } from "@/components/practice-summary-card";
import { MistakesContextCard } from "@/components/mistakes-context-card";
import { GraphContextCard } from "@/components/graph-context-card";
import { MistakesPage } from "@/components/mistakes-page";
import { CardCollapseProvider, CardCollapseStore } from "@/components/card-collapse-state";
import { InteractionLayersProvider } from "@/components/interaction-layers";
import { ServerEventsProvider } from "@/components/server-events";

describe("Practice v2 components render cleanly via SSR", () => {
	it("renders PracticeToolbar and PracticeDraftDials with all dials", () => {
		const toolbar = renderToStaticMarkup(
			<PracticeToolbar meta={DEFAULT_PRACTICE_META} onChange={() => {}} onWrapUp={() => {}} />,
		);
		assert.match(toolbar, /data-testid="practice-toolbar"/);
		assert.match(toolbar, /data-testid="practice-dial-coaching-balanced"/);
		assert.match(toolbar, /data-testid="practice-dial-verify"/);
		assert.match(toolbar, /data-testid="practice-wrap-up"/);

		const draft = renderToStaticMarkup(
			<PracticeDraftDials meta={DEFAULT_PRACTICE_META} onChange={() => {}} />,
		);
		assert.match(draft, /data-testid="practice-draft-dials"/);
		assert.match(draft, /data-testid="practice-draft-coaching-socratic"/);
	});

	it("renders PracticeProgressStrip with ledger counts", () => {
		const messages: LhMessage[] = [
			newGraphContextMessage([{ id: "n1", name: "Group order", statement: "|x| divides |G|" }], []),
			{
				id: newMessageId(),
				role: "assistant",
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
				content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "Q", mode: "recall", target: ["n1"], modelSolution: "S" } }],
			},
			{ id: newMessageId(), role: "toolResult", toolCallId: "p1", toolName: "problem", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
			{
				id: newMessageId(),
				role: "assistant",
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 3,
				content: [{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "surrendered", verdict: "Missed", rung: "R3", missClass: null, retest: true } }],
			},
			{ id: newMessageId(), role: "toolResult", toolCallId: "c1", toolName: "conclude", content: [{ type: "text", text: "done" }], isError: false, timestamp: 4 },
		];
		const html = renderToStaticMarkup(<PracticeProgressStrip messages={messages} />);
		assert.match(html, /data-testid="practice-progress-strip"/);
		assert.match(html, /1 problem/);
		assert.match(html, /1\/1 targets touched/);
		assert.match(html, /1 to retest/);
	});

	it("renders PracticeDock and structured docks with shared action hierarchy", () => {
		const openHtml = renderToStaticMarkup(
			<InteractionLayersProvider>
				<PracticeDock
					problemCallId="call_open"
					input={{ statement: "Prove $n^2$ is even implies $n$ is even." }}
					expanded
					onExpand={() => {}}
					onSubmit={() => {}}
				/>
			</InteractionLayersProvider>,
		);
		assert.match(openHtml, /data-testid="practice-dock"/);
		assert.match(openHtml, /Submit thinking/);
		assert.match(openHtml, /Hint/);
		assert.match(openHtml, /Show solution/);
		assert.match(openHtml, /data-testid="practice-attach-image"/);
		assert.match(openHtml, /data-testid="practice-attach-scratchpad"/);

		const checkHtml = renderToStaticMarkup(
			<InteractionLayersProvider>
				<PracticeCheckDock
					problemCallId="call_chk"
					input={{
						statement: "Pick primes",
						mode: "recall",
						multiSelect: true,
						options: [{ label: "2" }, { label: "4" }, { label: "3" }],
						correctAnswer: ["2", "3"],
						modelSolution: "2 and 3 are prime.",
					}}
					expanded
					onExpand={() => {}}
					onSubmitStructured={() => {}}
					onAction={() => {}}
				/>
			</InteractionLayersProvider>,
		);
		assert.match(checkHtml, /data-testid="practice-check-dock"/);
		assert.match(checkHtml, /Check answer/);
		assert.match(checkHtml, /Select all that apply/);

		const matchHtml = renderToStaticMarkup(
			<InteractionLayersProvider>
				<PracticeMatchDock
					problemCallId="call_mat"
					input={{
						statement: "Match categories",
						mode: "discrimination",
						categories: [{ id: "a", label: "Group" }, { id: "b", label: "Field" }],
						items: [
							{ id: "i1", prompt: "Single associative binary operation with identity and inverses" },
							{ id: "i2", prompt: "Both addition and nonzero multiplication form abelian groups" },
						],
						modelSolution: "Group axioms govern one operation; field axioms govern two.",
						correctMapping: { i1: "a", i2: "b" },
					}}
					expanded
					onExpand={() => {}}
					onSubmitStructured={() => {}}
					onAction={() => {}}
				/>
			</InteractionLayersProvider>,
		);
		assert.match(matchHtml, /data-testid="practice-match-dock"/);
		assert.match(matchHtml, /Check matches/);

		const codeHtml = renderToStaticMarkup(
			<InteractionLayersProvider>
				<PracticeCodeDock
					problemCallId="call_code"
					input={{
						statement: "Return double of x.",
						mode: "composition",
						language: "python",
						starterCode: "def double(x):\n    pass",
						modelSolution: "return x * 2",
					}}
					expanded
					onExpand={() => {}}
					onSubmitStructured={() => {}}
					onAction={() => {}}
					runtimeOverride={{ language: "python", run: async () => ({ stdout: "", timedOut: false, durationMs: 1 }) }}
				/>
			</InteractionLayersProvider>,
		);
		assert.match(codeHtml, /data-testid="practice-code-dock"/);
		assert.match(codeHtml, /Submit code/);
	});

	it("renders PracticeSummaryCard, MistakesContextCard, GraphContextCard neighbors, and MistakesPage button", () => {
		const summaryHtml = renderToStaticMarkup(
			<PracticeSummaryCard
				part={{
					type: "tool-practice_summary",
					state: "output-available",
					toolCallId: "sum1",
					input: {
						summary: "Good overall session.",
						solid: [{ area: "Parity", note: "Solid", targets: ["n1"] }],
						needsPractice: [{ area: "Cosets", note: "Slow start", targets: ["n2"] }],
						remedialTeach: [{ area: "Normality", note: "Conceptual gap", targets: ["n3"] }],
					},
				}}
			/>,
		);
		assert.match(summaryHtml, /data-testid="practice-summary-card"/);
		assert.match(summaryHtml, /Practice these again/);
		assert.match(summaryHtml, /Start remedial Teach/);

		const mistakesHtml = renderToStaticMarkup(
			<MistakesContextCard
				data={{ mistakes: [{ id: "m1", question: "Simplify -(a - b)", topic: "Rings", errorType: "signError", whatYouDid: "Dropped minus", rule: "Check signs" }] }}
			/>,
		);
		assert.match(mistakesHtml, /data-testid="mistakes-context-card"/);
		assert.match(mistakesHtml, /1 mistake/);

		const graphHtml = renderToStaticMarkup(
			<GraphContextCard
				data={{
					propositions: [{ id: "n1", name: "Picked", statement: "S1" }],
					chains: [],
					neighbors: [{ id: "n2", name: "Adjacent", statement: "S2" }],
					neighborChains: ["c1: Picked → Adjacent"],
				}}
			/>,
		);
		assert.match(graphHtml, /data-testid="graph-context-toggle"/);

		const collapseStore = new CardCollapseStore("test-mistakes-ssr");
		const mistakesPageHtml = renderToStaticMarkup(
			<ServerEventsProvider>
				<InteractionLayersProvider>
					<CardCollapseProvider store={collapseStore}>
						<MistakesPage />
					</CardCollapseProvider>
				</InteractionLayersProvider>
			</ServerEventsProvider>,
		);
		assert.match(mistakesPageHtml, /data-testid="mistakes-practice-filtered"/);
		assert.match(mistakesPageHtml, /Practice filtered/);
	});
});
