import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { CardCollapseProvider, CardCollapseStore } from "../components/card-collapse-state.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { CodeExerciseAnsweredCard } from "../components/code-exercise-answered-card.tsx";
import type { CodeExerciseAnswerData, QuestionAnswerData } from "../src/core/index.ts";

function installMockStorage() {
	const store = new Map<string, string>();
	(globalThis as Record<string, unknown>).window = {
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => { store.set(k, v); },
			removeItem: (k: string) => { store.delete(k); },
		},
	};
	return store;
}

const quizAnswer: QuestionAnswerData = {
	kind: "quiz",
	tool: "quiz",
	questionType: "predict",
	questionText: "What is the curl of a conservative vector field?",
	options: [
		{ index: 1, label: "Zero vector" },
		{ index: 2, label: "Unit normal" },
	],
	dontKnow: false,
	answers: [{ index: 1, label: "Zero vector", value: "zero" }],
	correct: true,
	correctIndices: [1],
	explanation: "Mixed partials cancel by Clairaut's theorem.",
	confidence: 90,
	answeredAt: new Date().toISOString(),
};

const codeAnswer: CodeExerciseAnswerData = {
	kind: "code-exercise",
	questionText: "Write a function returning x * x.",
	language: "python",
	code: "def sq(x):\n    return x * x",
	graded: true,
	runs: 1,
	lastRun: { passed: true, timedOut: false, stdout: "ok" },
	answeredAt: new Date().toISOString(),
};

describe("CardCollapseStore", () => {
	it("collapses older cards by default, keeps latest expanded, and persists overrides", () => {
		const backing = installMockStorage();
		const s = new CardCollapseStore("chat_test_1");
		s.setLatestCardId("card_latest");
		assert.equal(s.isOpen("card_old"), false);
		assert.equal(s.isOpen("card_latest"), true);

		s.setOpen("card_old", true);
		s.setOpen("card_latest", false);
		assert.equal(s.isOpen("card_old"), true);
		assert.equal(s.isOpen("card_latest"), false);

		// Reload from localStorage
		assert.ok(backing.has("lh:card-collapse:chat_test_1"));
		const reloaded = new CardCollapseStore("chat_test_1");
		reloaded.setLatestCardId("card_latest");
		assert.equal(reloaded.isOpen("card_old"), true);
		assert.equal(reloaded.isOpen("card_latest"), false);
	});
});

describe("Collapsible AnsweredCard and CodeExerciseAnsweredCard", () => {
	it("renders older cards as one-line collapsed bars and latest card expanded", () => {
		installMockStorage();
		const s = new CardCollapseStore("chat_test_2");
		s.setLatestCardId("c2");

		const html = renderToStaticMarkup(
			<CardCollapseProvider store={s}>
				<AnsweredCard answer={quizAnswer} cardId="c1" />
				<AnsweredCard answer={quizAnswer} cardId="c2" />
				<CodeExerciseAnsweredCard answer={codeAnswer} cardId="c3" />
			</CardCollapseProvider>,
		);
		const doc = parseHTML(`<html><body>${html}</body></html>`).document;

		const c1 = doc.querySelector('[data-answered-card="c1"]')!;
		assert.equal(c1.getAttribute("data-testid"), "answered-card-bar");
		assert.equal(c1.getAttribute("aria-expanded"), "false");
		assert.match(c1.textContent!, /Prediction/);
		assert.match(c1.textContent!, /correct/);
		assert.match(c1.textContent!, /90%/);

		const c2 = doc.querySelector('[data-answered-card="c2"]')!;
		assert.equal(c2.getAttribute("data-testid"), "answered-card");
		assert.ok(c2.querySelector('[data-testid="answered-card-toggle"]'));
		assert.ok(c2.querySelector('[data-testid="answered-card-collapse-bottom"]'));

		const c3 = doc.querySelector('[data-answered-card="c3"]')!;
		assert.equal(c3.getAttribute("data-testid"), "answered-card-bar");
		assert.equal(c3.getAttribute("aria-expanded"), "false");
		assert.match(c3.textContent!, /Code/);
	});
});
