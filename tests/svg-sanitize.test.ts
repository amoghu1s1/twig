/**
 * Generated-SVG sanitizer (security review, ported from the jacobderechin
 * fork, 2026-11-08): namespace-aware, so an aliased XLink prefix (`h:href`)
 * is caught like `xlink:href`. The regression check renders the SANITIZED
 * output with resvg — a native rasterizer that resolves local image paths by
 * itself, i.e. the most permissive renderer available — and asserts a
 * distinctive canary PNG outside every grant never appears. (Production
 * rasterizes in the sandboxed browser page, which blocks file:// on top of
 * this.)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { sanitizeSvg, SvgRejectedError } from "../src/agent/subagents/svg-sanitize.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-svg-canary-"));
const canary = path.join(dir, "private-canary.png");
{
	const c = createCanvas(10, 10);
	const x = c.getContext("2d");
	x.fillStyle = "#ff0000";
	x.fillRect(0, 0, 10, 10);
	fs.writeFileSync(canary, c.toBuffer("image/png"));
}

/** Is the canary's red at the center of the rendered PNG? */
async function showsCanary(svg: string): Promise<boolean> {
	const png = new Resvg(svg, { background: "#ffffff", font: { loadSystemFonts: false } }).render().asPng();
	const img = await loadImage(png);
	const cv = createCanvas(img.width, img.height);
	const cx = cv.getContext("2d");
	cx.drawImage(img, 0, 0);
	const [r, g, b] = cx.getImageData(5, 5, 1, 1).data;
	return r! > 200 && g! < 50 && b! < 50;
}

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = "http://www.w3.org/1999/xlink";
const relative = path.relative(process.cwd(), canary);
const VARIANTS: Record<string, string> = {
	plain: `<svg ${NS} width="10" height="10"><image href="${canary}" width="10" height="10"/></svg>`,
	xlink: `<svg ${NS} xmlns:xlink="${XLINK}" width="10" height="10"><image xlink:href="${canary}" width="10" height="10"/></svg>`,
	aliased: `<svg ${NS} xmlns:h="${XLINK}" width="10" height="10"><image h:href="${canary}" width="10" height="10"/></svg>`,
	nestedAlias: `<svg ${NS} width="10" height="10"><g xmlns:q="${XLINK}"><image q:href="${canary}" width="10" height="10"/></g></svg>`,
	relative: `<svg ${NS} width="10" height="10"><image href="${relative}" width="10" height="10"/></svg>`,
	fileUrl: `<svg ${NS} width="10" height="10"><image href="file://${canary}" width="10" height="10"/></svg>`,
	feImage: `<svg ${NS} width="10" height="10"><filter id="f"><feImage href="${canary}"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>`,
};

describe("sanitizeSvg — the canary never renders", () => {
	it("the threat is real: unsanitized, the native renderer loads the canary through aliased prefixes", async () => {
		assert.equal(await showsCanary(VARIANTS.aliased!), true, "control: proves the canary is reachable unsanitized");
	});
	for (const [name, svg] of Object.entries(VARIANTS)) {
		it(`${name}: sanitized output never shows the canary`, async () => {
			const out = sanitizeSvg(svg);
			assert.ok(!out.includes(canary) && !out.includes(relative), out);
			assert.equal(await showsCanary(out), false);
		});
	}
});

describe("sanitizeSvg — rules", () => {
	it("keeps inline images, fragments, and ordinary drawing", () => {
		const svg = `<svg ${NS} xmlns:xlink="${XLINK}" width="10" height="10"><defs><circle id="d" r="2"/></defs><use xlink:href="#d"/><image href="data:image/png;base64,AA=="/><rect fill="url(#g)" width="1" height="1"/></svg>`;
		const out = sanitizeSvg(svg);
		assert.match(out, /href="#d"/);
		assert.match(out, /href="data:image\/png;base64,AA=="/);
		assert.match(out, /fill="url\(#g\)"/);
	});
	it("drops scripts, foreignObject, handlers, and fetching CSS", () => {
		const svg = `<svg ${NS} onload="x()"><script>x()</script><foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="/a.png"/></foreignObject><rect onclick="y()" style="fill:url(/etc/x.svg#a)"/><style>@import url(/x.css);</style></svg>`;
		const out = sanitizeSvg(svg);
		assert.doesNotMatch(out, /script|foreignObject|onload|onclick|@import|\/etc\/x/i);
	});
	it("a bare <svg> (no xmlns) is accepted and comes out namespaced", () => {
		assert.match(sanitizeSvg('<svg width="5"><rect width="1" height="1"/></svg>'), /^<svg width="5" xmlns="http:\/\/www\.w3\.org\/2000\/svg">/);
	});

	it("refuses DTDs, entities, stylesheet PIs, malformed XML, and non-SVG roots", () => {
		for (const bad of [
			`<!DOCTYPE svg [<!ENTITY p "${canary}">]><svg ${NS}><image href="&p;"/></svg>`,
			`<?xml-stylesheet href="/x.css"?><svg ${NS}/>`,
			`<svg ${NS}><rect></svg>`,
			`<html xmlns="http://www.w3.org/1999/xhtml"/>`,
		]) {
			assert.throws(() => sanitizeSvg(bad), SvgRejectedError, bad);
		}
	});
});
