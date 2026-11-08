/**
 * TypeScript → JavaScript in the browser, with sucrase. Only types and
 * other TS-only syntax are removed — no type checking, and no bundler
 * transforms. The result runs in the same opaque-origin Worker as plain
 * JavaScript, so both languages share one sandbox and one protocol.
 *
 * The import is lazy: a Python-only session never downloads sucrase.
 */

type SucraseModule = typeof import("sucrase");

let loaded: Promise<SucraseModule> | undefined;

export async function transpileTypeScript(source: string): Promise<string> {
	loaded ??= import("sucrase");
	const { transform } = await loaded;
	return transform(source, { transforms: ["typescript"], disableESTransforms: true }).code;
}
