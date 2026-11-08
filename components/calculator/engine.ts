/**
 * The floating calculator's math: mathjs with angle-aware trig.
 *
 * Trig takes and returns angles in the panel's mode (degrees or radians);
 * an explicit unit always wins (`sin(30 deg)`, `cos(1 rad)`). Results that
 * floating point leaves a hair off are cleaned up (sin(180) is 0, tan(90)
 * is ∞), `log` is base 10 with `ln` natural (the calculator convention),
 * and `°`, `π`, `√`, `×`, `÷` can be typed directly. Expression-level
 * import/parse/evaluate are disabled, per mathjs's security guidance.
 */
import { all, create } from "mathjs";

export type AngleMode = "deg" | "rad";

export type CalcResult = { ok: true; value: unknown; text: string } | { ok: false; error: string };

// mathjs types `all` as optional; the full bundle always exports it.
const math = create(all as NonNullable<typeof all>, { number: "number" });
// Keep the real entry points before locking the expression language down.
const evaluate = math.evaluate.bind(math);
const format = math.format.bind(math);
const disabled = (name: string) => () => {
	throw new Error(`${name} isn't available in the calculator`);
};
math.import(
	{
		import: disabled("import"),
		createUnit: disabled("createUnit"),
		evaluate: disabled("evaluate"),
		parse: disabled("parse"),
		compile: disabled("compile"),
		simplify: disabled("simplify"),
		derivative: disabled("derivative"),
		resolve: disabled("resolve"),
		reviver: disabled("reviver"),
	},
	{ override: true },
);

const RAD_PER_DEG = Math.PI / 180;
/** Below this, a trig result is floating-point noise for zero. */
const EPSILON = 1e-12;

/** A trig result without floating-point noise: near-zero is 0, and 15
 *  significant digits make sin(30°) exactly 0.5 (so `ans` is what's shown). */
const clean = (v: number) => (Math.abs(v) < EPSILON ? 0 : Number.isFinite(v) ? Number(v.toPrecision(15)) : v);

/** A trig argument in radians: units convert themselves, plain numbers
 *  are in the panel's mode. */
function radians(x: unknown, mode: AngleMode): number {
	if (math.isUnit(x)) return (x as { toNumber: (unit: string) => number }).toNumber("rad");
	if (typeof x === "number") return mode === "deg" ? x * RAD_PER_DEG : x;
	throw new TypeError("trig functions take a number or an angle");
}

function plain(x: unknown): number {
	if (typeof x === "number") return x;
	throw new TypeError("expects a number");
}

const fromRadians = (rad: number, mode: AngleMode) => clean(mode === "deg" ? rad / RAD_PER_DEG : rad);

/** One function applied element by element to arrays and matrices. */
function elementwise(f: (x: unknown) => number) {
	return (x: unknown) => (Array.isArray(x) || math.isMatrix(x) ? math.map(x as never, (v: unknown) => f(v)) : f(x));
}

/** A ratio of trig values; a zero denominator (cos 90°) is ±∞, not 1e16. */
function ratio(top: number, bottom: number): number {
	if (Math.abs(bottom) < EPSILON) return top >= 0 ? Infinity : -Infinity;
	return clean(top / bottom);
}

/** The functions that depend on the angle mode (passed as scope, which
 *  shadows mathjs's own). */
function trigScope(mode: AngleMode): Record<string, unknown> {
	const r = (x: unknown) => radians(x, mode);
	return {
		sin: elementwise((x) => clean(Math.sin(r(x)))),
		cos: elementwise((x) => clean(Math.cos(r(x)))),
		tan: elementwise((x) => ratio(Math.sin(r(x)), Math.cos(r(x)))),
		sec: elementwise((x) => ratio(1, Math.cos(r(x)))),
		csc: elementwise((x) => ratio(1, Math.sin(r(x)))),
		cot: elementwise((x) => ratio(Math.cos(r(x)), Math.sin(r(x)))),
		asin: elementwise((x) => fromRadians(Math.asin(plain(x)), mode)),
		acos: elementwise((x) => fromRadians(Math.acos(plain(x)), mode)),
		atan: elementwise((x) => fromRadians(Math.atan(plain(x)), mode)),
		asec: elementwise((x) => fromRadians(Math.acos(1 / plain(x)), mode)),
		acsc: elementwise((x) => fromRadians(Math.asin(1 / plain(x)), mode)),
		acot: elementwise((x) => fromRadians(Math.atan(1 / plain(x)), mode)),
		atan2: (y: unknown, x: unknown) => fromRadians(Math.atan2(plain(y), plain(x)), mode),
		ln: (x: unknown) => math.log(x as number),
		log: (x: unknown, base?: unknown) => (base === undefined ? math.log10(x as number) : math.log(x as number, base as number)),
	};
}

/** Calculator spellings mathjs doesn't parse, rewritten. */
export function normalizeExpression(expression: string): string {
	return expression
		.replace(/π/g, "pi")
		// √2 / √x (no parentheses) is √ of that one number or name.
		.replace(/√\s*(\d+(?:\.\d+)?|[a-zA-Z_]\w*)\b(?!\s*\()/g, "sqrt($1)")
		.replace(/√/g, "sqrt")
		.replace(/²/g, "^2")
		.replace(/³/g, "^3")
		.replace(/°/g, " deg")
		.replace(/×/g, "*")
		.replace(/÷/g, "/")
		.replace(/−/g, "-");
}

/** A result as the panel shows it: up to 10 significant digits. */
export function formatResult(value: unknown): string {
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "not a real number";
		if (value === Infinity) return "∞";
		if (value === -Infinity) return "−∞";
		if (Object.is(value, -0)) return "0";
	}
	return format(value, { precision: 10, lowerExp: -9, upperExp: 12 });
}

/**
 * Evaluate one line. null for a blank line. `ans` is the previous result.
 * Multi-statement lines (`a = 3; a * 2`) show their last value.
 */
export function calculate(expression: string, options: { angle: AngleMode; ans?: unknown }): CalcResult | null {
	const source = normalizeExpression(expression).trim();
	if (!source) return null;
	try {
		const scope = { ...trigScope(options.angle), ...(options.ans === undefined ? {} : { ans: options.ans }) };
		let value: unknown = evaluate(source, scope);
		if (math.isResultSet(value)) {
			const entries = (value as { entries: unknown[] }).entries;
			value = entries[entries.length - 1];
		}
		if (value === undefined) return { ok: false, error: "Nothing to show" };
		if (typeof value === "function") return { ok: false, error: "Call it with a value, like sin(30)" };
		return { ok: true, value, text: formatResult(value) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
