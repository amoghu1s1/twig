#!/usr/bin/env node
/**
 * style-check — a heuristic checker for the learner-facing style contract.
 *
 * It finds the specific rhetorical tics that make an explanation sound staged:
 * meta commentary, aphoristic singularity, three-part negation, and a few
 * related patterns. It does not penalize headings, bullets, bold, equations,
 * em-dashes, or questions by themselves. Those are normal explanatory tools.
 *
 * Usage:
 *   node scripts/style-check.mjs output.md
 *   node scripts/style-check.mjs --strict output.md
 *   cat output.md | node scripts/style-check.mjs
 */

import fs from "node:fs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const files = args.filter((arg) => !arg.startsWith("--"));

/** Remove fenced code and inline code so code samples never count as prose. */
function stripCode(text) {
	return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

function count(re, text) {
	return (text.match(re) ?? []).length;
}

/** Patterns that make the prose sound staged rather than explanatory. */
const HARD = [
	{
		label: "meta commentary about the question, method, prompt, or harness",
		re: /\b(?:your question|the standard method|the whole point|what this means|here's what|the key is|the thing is|this is what the)\b/gi,
	},
	{ label: "'the entire point/thing/story'", re: /\bthe entire (?:point|thing|story|reason|idea)\b/gi },
	{ label: "'exactly one answer/way'", re: /\bexactly one (?:answer|way|thing)\b/gi },
	{
		label: "three-part negation used as a flourish",
		re: /\b(?:No|Not)\b[^.!?\n]{0,60}\b(?:no|not)\b[^.!?\n]{0,60}\b(?:no|not)\b/gi,
	},
];

/** Patterns worth reviewing, but not automatic failures. */
const WARN = [
	{ label: "'not X but Y' contrast", re: /\bnot\b[^.!?\n]{0,80}\bbut\b/gi },
	{ label: "'No X, no Y' list", re: /\bNo\b[^.!?\n]{0,60}\bno\b/g },
	{ label: "'Just X'", re: /\bJust\b/g },
	{
		label: "closing meta-summary about the explanation",
		re: /\b(?:came|comes) (?:from|out of)\b|\bnothing was (?:derived|used|assumed|borrowed)\b|\beverything (?:was|is) (?:explicitly )?(?:stated|derived|shown)\b|\bno \w+ (?:appeared|was used|was borrowed)\b|\bthe real content\b|\bwhat this shows\b|\bthis is where .* (?:comes|enters)\b|(?:^|[.!?]\s+)the point is\b|\bthat is the difference\b/gim,
	},
	{
		label: "abstraction used as an agent",
		re: /\b(?:the|this|that)\s+(?:material|connection|map|check|prediction|plan|step|fact|question|answer|lesson|hour|exercise|method|reasoning|prose|structure|work|reply|message|sentence|paragraph|session|edge|foundation|idea|concept|point)\s+(?:is|are|does|do|decides|carries|fires|arrives|moves|serves|lands|makes|needs|wants|uses|works|comes|goes|stays|becomes|turns|keeps|holds|draws|builds|runs|follows|determines|belongs|exists|means)\b/gi,
	},
	{
		label: "mathematical object used as an agent",
		re: /\b(?:limit|derivative|integral|equation|identity|proof|derivation|result|formula|function|graph|curve|expression|term|coefficient|diagram|figure|plan|fact|answer|check|verdict|prediction|button|prose)\s+(?:removes?|leaves?|forces?|tells?|shows?|gives?|owns?|wants?|decides?|carries?|serves?|belongs?|moves?|sits?|stands?|lands?|fires?|arrives?|opens?|hands?|brings?|produces?|yields?)\b/gi,
	},
	{
		label: "'is forced' or facts that sit",
		re: /\b(?:is|are) forced\b|\b(?:facts?|definitions?|ideas?|propositions?)\s+sit\b/gi,
	},
];

/** Neutral counts. These are normal explanatory tools, not failures. */
const INFO = [
	{ label: "em-dashes", re: /—/g },
	{ label: "question marks", re: /\?/g },
];

/** Split prose into sentence-like units for basic length statistics. */
function sentenceStats(text) {
	const sentences = text
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const lengths = sentences
		.map((sentence) => sentence.split(/\s+/).filter(Boolean).length)
		.sort((a, b) => a - b);
	const total = lengths.reduce((sum, value) => sum + value, 0);
	return {
		count: lengths.length,
		mean: lengths.length ? total / lengths.length : 0,
		median: lengths[Math.floor(lengths.length / 2)] ?? 0,
		p90: lengths[Math.floor(lengths.length * 0.9)] ?? 0,
		max: lengths[lengths.length - 1] ?? 0,
	};
}

function report(name, raw) {
	const text = stripCode(raw);
	const stats = sentenceStats(text);
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	let hard = 0;
	let warnings = 0;

	console.log(`\nSTYLE REPORT: ${name}`);
	console.log(`  words: ${words}`);
	console.log(
		`  sentences: ${stats.count}, mean ${stats.mean.toFixed(1)} words, ` +
			`median ${stats.median}, p90 ${stats.p90}, max ${stats.max}`,
	);

	for (const rule of HARD) {
		const n = count(rule.re, text);
		if (n > 0) {
			hard += n;
			console.log(`  FAIL ${n}  ${rule.label}`);
		}
	}
	for (const rule of WARN) {
		const n = count(rule.re, text);
		if (n > 0) {
			warnings += n;
			console.log(`  warn ${n}  ${rule.label}`);
		}
	}
	for (const rule of INFO) {
		const n = count(rule.re, text);
		if (n > 0) console.log(`  info ${n}  ${rule.label}`);
	}

	if (hard === 0 && warnings === 0) console.log("  PASS");
	else if (hard === 0) console.log("  REVIEW: no hard failures; review the warnings");
	else console.log("  FAIL: rewrite the flagged sentences");

	return { hard, warnings };
}

function readInputs() {
	if (files.length > 0) {
		return files.map((file) => ({ name: file, text: fs.readFileSync(file, "utf8") }));
	}
	if (process.stdin.isTTY) {
		console.error("usage: node scripts/style-check.mjs [--strict] <file...>");
		console.error("       cat output.md | node scripts/style-check.mjs");
		process.exit(1);
	}
	return [{ name: "<stdin>", text: fs.readFileSync(0, "utf8") }];
}

const inputs = readInputs();
let totalHard = 0;
let totalWarnings = 0;
for (const input of inputs) {
	const result = report(input.name, input.text);
	totalHard += result.hard;
	totalWarnings += result.warnings;
}

console.log(`\n${inputs.length} file(s), ${totalHard} hard failure(s), ${totalWarnings} warning(s)`);
if (strict && totalHard > 0) process.exitCode = 1;
