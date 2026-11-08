/**
 * The floating calculator's math (degree-aware trig on mathjs), its
 * remembered state, and its shortcut.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculate, formatResult, normalizeExpression, type AngleMode } from "../components/calculator/engine.ts";
import { clampPosition, DEFAULT_STATE, HISTORY_LIMIT, parseCalculatorState } from "../components/calculator/state.ts";
import { KEYBOARD_ACTIONS, actionForBinding, bindingForAction } from "../src/core/keyboard.ts";

const text = (expr: string, angle: AngleMode = "deg", ans?: unknown) => {
	const r = calculate(expr, { angle, ans });
	return r?.ok ? r.text : r;
};

describe("calculator math", () => {
	it("does trig in degrees, and inverse trig answers in degrees", () => {
		assert.equal(text("sin(30)"), "0.5");
		assert.equal(text("cos(60)"), "0.5");
		assert.equal(text("tan(45)"), "1");
		assert.equal(text("asin(0.5)"), "30");
		assert.equal(text("acos(0)"), "90");
		assert.equal(text("atan2(1, 1)"), "45");
		assert.equal(text("cot(45)"), "1");
		assert.equal(text("sec(60)"), "2");
	});

	it("does trig in radians on the RAD setting", () => {
		assert.equal(text("sin(pi/6)", "rad"), "0.5");
		assert.equal(text("asin(1)", "rad"), "1.570796327");
	});

	it("lets an explicit unit win over the setting", () => {
		assert.equal(text("sin(30 deg)", "rad"), "0.5");
		assert.equal(text("sin(30°)", "rad"), "0.5");
		assert.equal(text("cos((pi/3) rad)", "deg"), "0.5");
	});

	it("returns exact trig values, not floating-point near-misses", () => {
		assert.equal((calculate("sin(30)", { angle: "deg" }) as { value: number }).value, 0.5);
		assert.equal((calculate("asin(0.5)", { angle: "deg" }) as { value: number }).value, 30);
	});

	it("cleans up floating-point noise: exact zeros and infinities", () => {
		assert.equal(text("sin(180)"), "0");
		assert.equal(text("cos(90)"), "0");
		assert.equal(text("tan(90)"), "∞");
		assert.equal(text("tan(270)"), "−∞");
		assert.equal(text("0.1 + 0.2"), "0.3");
	});

	it("reports results that aren't real numbers", () => {
		assert.equal(text("acos(2)"), "not a real number");
	});

	it("reads calculator spellings and conventions", () => {
		assert.equal(text("√2"), "1.414213562");
		assert.equal(text("2√2"), "2.828427125");
		assert.equal(text("√(9)"), "3");
		assert.equal(text("3²"), "9");
		assert.equal(text("2π"), "6.283185307");
		assert.equal(text("6 × 7 ÷ 2 − 1"), "20");
		assert.equal(text("log(100)"), "2");
		assert.equal(text("ln(e)"), "1");
		assert.equal(text("log(8, 2)"), "3");
		assert.equal(text("hypot(3, 4)"), "5");
		assert.equal(normalizeExpression("√x + π°"), "sqrt(x) + pi deg");
		// √ before a function call never splits the function's name.
		assert.equal(normalizeExpression("√sin(30)"), "sqrtsin(30)");
		assert.equal(normalizeExpression("√(9) + √sin2"), "sqrt(9) + sqrt(sin2)");
	});

	it("uses ans, multi-statement lines, and lists", () => {
		assert.equal(text("ans * 2", "deg", 21), "42");
		assert.equal(text("a = 3; a * 2"), "6");
		assert.equal(text("sin([30, 90])"), "[0.5, 1]");
	});

	it("explains incomplete or wrong input, and treats a blank line as nothing", () => {
		assert.equal(calculate("   ", { angle: "deg" }), null);
		for (const [expr, message] of [
			["sin(", /end of expression/],
			["foo + 1", /Undefined symbol foo/],
			["sin", /Call it with a value/],
		] as const) {
			const r = calculate(expr, { angle: "deg" });
			assert.ok(r && !r.ok && message.test(r.error), expr);
		}
	});

	it("keeps the expression language locked down", () => {
		for (const expr of ['evaluate("1+1")', "import({})", 'parse("1")', 'createUnit("foo")']) {
			const r = calculate(expr, { angle: "deg" });
			assert.ok(r && !r.ok && /isn't available/.test(r.error), expr);
		}
	});

	it("formats to about 10 significant digits", () => {
		assert.equal(formatResult(1 / 3), "0.3333333333");
		assert.equal(formatResult(-0), "0");
		assert.equal(formatResult(1e20), "1e+20");
		assert.equal(formatResult(Infinity), "∞");
	});
});

describe("calculator state", () => {
	it("keeps only well-formed stored fields", () => {
		assert.deepEqual(parseCalculatorState(null), DEFAULT_STATE);
		assert.deepEqual(parseCalculatorState("garbage"), DEFAULT_STATE);
		const parsed = parseCalculatorState({
			open: true,
			position: { x: 10, y: Number.NaN },
			angle: "grad",
			history: [{ expression: "sin(30)", text: "0.5" }, { expression: 1 }, "x"],
			ans: "5",
		});
		assert.deepEqual(parsed, { open: true, position: null, angle: "deg", history: [{ expression: "sin(30)", text: "0.5" }], ans: null });
		const long = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => ({ expression: String(i), text: String(i) }));
		const kept = parseCalculatorState({ history: long }).history;
		assert.equal(kept.length, HISTORY_LIMIT);
		assert.equal(kept[0]!.expression, "5", "the oldest entries go first");
	});

	it("clamps the panel inside the window", () => {
		const size = { width: 320, height: 300 };
		const viewport = { width: 1000, height: 700 };
		assert.deepEqual(clampPosition({ x: 100, y: 100 }, size, viewport), { x: 100, y: 100 });
		assert.deepEqual(clampPosition({ x: -50, y: -10 }, size, viewport), { x: 8, y: 8 });
		assert.deepEqual(clampPosition({ x: 2000, y: 2000 }, size, viewport), { x: 672, y: 392 });
		// A window smaller than the panel pins it to the top-left margin.
		assert.deepEqual(clampPosition({ x: 50, y: 50 }, size, { width: 200, height: 200 }), { x: 8, y: 8 });
	});
});

describe("calculator shortcut", () => {
	it("toggles on Alt+C, a binding nothing else uses", () => {
		assert.equal(bindingForAction("toggle-calculator"), "alt+c");
		assert.equal(actionForBinding("alt+c"), "toggle-calculator");
		const bindings = KEYBOARD_ACTIONS.filter((a) => !a.displayOnly).map((a) => a.binding);
		assert.equal(new Set(bindings).size, bindings.length, "no two actions share a binding");
	});
});
