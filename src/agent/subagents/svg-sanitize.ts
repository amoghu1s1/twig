import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

/**
 * Generated-SVG sanitizer (security review, ported from the jacobderechin
 * fork, 2026-11-08) — defense in depth IN FRONT OF the sandboxed browser
 * renderer (headless.ts renderSvg), which is the actual enforcement
 * boundary (no file://, no network).
 *
 * A regex over attribute names is not enough: XML namespaces mean
 * `<image h:href="/abs/file">` with xmlns:h bound to the XLink namespace IS
 * an xlink:href. This pass is namespace-aware: it parses the document,
 * judges attributes by LOCAL name in every namespace, and the renderer only
 * ever sees the re-serialized result (no parser differential on the input).
 *
 *  - refuse DTDs, entity declarations, and stylesheet processing
 *    instructions outright (entity expansion and external stylesheets are
 *    classic ways around attribute filters);
 *  - drop <script>, <foreignObject> (embedded HTML), every on* handler;
 *  - drop every `href` (any namespace or none) unless it is an inline
 *    image (data:image/…) or a same-document fragment (#id);
 *  - drop CSS that could fetch: attribute or <style> text with url()
 *    pointing anywhere but #fragment / data:, @import, or backslash escapes
 *    (CSS escape sequences are a filter-bypass idiom).
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export class SvgRejectedError extends Error {}

const SAFE_REF = /^\s*(#|data:image\/)/i;
/** url(...) whose target is not a #fragment or data: URI, @import, or a
 *  CSS escape (which could spell url() / @import past a plain-text filter). */
const UNSAFE_CSS = /@import|\\|url\(\s*(['"]?)\s*(?!#|data:)/i;

type XNode = {
	nodeType: number;
	nodeName: string;
	localName?: string | null;
	namespaceURI?: string | null;
	childNodes: ArrayLike<XNode>;
	parentNode: XNode | null;
	attributes?: ArrayLike<{ name: string; localName?: string | null; value: string }>;
	removeAttribute?(name: string): void;
	setAttribute?(name: string, value: string): void;
	removeChild(node: XNode): void;
	textContent: string | null;
	data?: string;
	target?: string;
};

/** The local part of an attribute name, prefix or not. */
function localName(attr: { name: string; localName?: string | null }): string {
	return (attr.localName ?? attr.name.split(":").pop() ?? "").toLowerCase();
}

function clean(node: XNode): void {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === 7) {
			// processing instruction
			if (/stylesheet/i.test(child.target ?? child.nodeName)) throw new SvgRejectedError("stylesheet processing instructions are not allowed");
			node.removeChild(child);
			continue;
		}
		if (child.nodeType !== 1) continue;
		const local = (child.localName ?? child.nodeName).toLowerCase();
		if (local === "script" || local === "foreignobject") {
			node.removeChild(child);
			continue;
		}
		if (local === "style" && UNSAFE_CSS.test(child.textContent ?? "")) {
			node.removeChild(child);
			continue;
		}
		for (const attr of Array.from(child.attributes ?? [])) {
			const name = localName(attr);
			const drop =
				name.startsWith("on") ||
				attr.name.toLowerCase() === "xml:base" ||
				(name === "href" && !SAFE_REF.test(attr.value)) ||
				UNSAFE_CSS.test(attr.value);
			if (drop) child.removeAttribute!(attr.name);
		}
		clean(child);
	}
}

/** Parse, clean, and re-serialize a generated SVG; throws SvgRejectedError
 *  for documents that must not be rendered at all. */
export function sanitizeSvg(svg: string): string {
	if (/<!DOCTYPE|<!ENTITY/i.test(svg)) throw new SvgRejectedError("SVG documents with a DTD or entity declarations are not allowed");
	// xmldom 0.8 calls malformed markup a "warning" too. Nothing valid warns,
	// so any parser complaint rejects the document (no parser differential
	// between what this sanitizer checked and what the browser parses).
	// &nbsp; is an HTML-ism the display path already repairs; normalize it
	// before parsing instead of failing a perfectly ordinary figure.
	const source = svg.trim().replace(/&nbsp;/g, "&#160;");
	let doc: { documentElement: XNode | null; childNodes: ArrayLike<XNode> };
	try {
		doc = new DOMParser({
			errorHandler: (_level: string, message: string) => {
				throw new SvgRejectedError(`invalid SVG: ${message}`);
			},
		}).parseFromString(source, "image/svg+xml") as unknown as typeof doc;
	} catch (err) {
		throw err instanceof SvgRejectedError ? err : new SvgRejectedError(`invalid SVG: ${(err as Error).message}`);
	}
	// Document-level processing instructions sit beside the root, not in it.
	for (const node of Array.from(doc.childNodes)) {
		if (node.nodeType === 7 && /stylesheet/i.test(node.target ?? node.nodeName)) {
			throw new SvgRejectedError("stylesheet processing instructions are not allowed");
		}
	}
	const root = doc.documentElement;
	if (!root || (root.localName ?? root.nodeName) !== "svg") {
		throw new SvgRejectedError("the document root must be an <svg> element in the SVG namespace");
	}
	if (root.namespaceURI && root.namespaceURI !== SVG_NS) {
		throw new SvgRejectedError("the document root must be an <svg> element in the SVG namespace");
	}
	// A bare <svg> (no xmlns) is legal input here; name the namespace so the
	// sandboxed browser parses the re-serialized document as SVG.
	if (!root.namespaceURI && root.setAttribute) root.setAttribute("xmlns", SVG_NS);
	for (const attr of Array.from(root.attributes ?? [])) {
		const name = localName(attr);
		if (name.startsWith("on") || attr.name.toLowerCase() === "xml:base" || UNSAFE_CSS.test(attr.value)) root.removeAttribute!(attr.name);
	}
	clean(root);
	return new XMLSerializer().serializeToString(root as never);
}
