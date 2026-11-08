/**
 * Generated-content sandbox (security hardening, ported from the
 * jacobderechin fork, 2026-11-08): the shared no-network policy
 * (src/core/demo-sandbox.ts), the iframe srcDoc it rides in, the demo
 * viewer download, the verifier's request classifier (no file://, no
 * network), and parity of every copy of the policy (main.cjs helper, the
 * smoke probe), plus the Chrome OS sandbox.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEMO_CSP, DEMO_SANDBOX_URL, withDemoCsp } from "../src/core/demo-sandbox.ts";
import { buildDemoSrcDoc, buildDemoViewer } from "../components/artifacts/demo-card.tsx";
import { sandboxRequestKind } from "../src/agent/subagents/headless.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("DEMO_CSP", () => {
	it("allows inline code and inline media, and no network at all", () => {
		assert.match(DEMO_CSP, /default-src 'none'/);
		assert.match(DEMO_CSP, /connect-src 'none'/);
		assert.doesNotMatch(DEMO_CSP, /https?:|\*|'self'/, "no remote or self source anywhere");
	});
});

describe("withDemoCsp / buildDemoSrcDoc", () => {
	it("puts the meta right after the doctype (standards mode, governs every script)", () => {
		const out = withDemoCsp("<!DOCTYPE html><html><head><script>1</script></head></html>");
		assert.ok(out.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"'));
		assert.ok(out.indexOf("Content-Security-Policy") < out.indexOf("<script>"));
	});
	it("prepends when there is no doctype", () => {
		assert.ok(withDemoCsp("<script>1</script>").startsWith("<meta http-equiv=\"Content-Security-Policy\""));
	});
	it("the learner's iframe document carries the policy and the bridge", () => {
		const doc = buildDemoSrcDoc("<!doctype html><body><p>x</p></body>");
		assert.match(doc, /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
		assert.match(doc, /demo-resize/);
	});
});

describe("buildDemoViewer (the safe demo download)", () => {
	it("frames the demo in an allow-scripts-only sandbox under the demo CSP, with everything escaped", () => {
		const out = buildDemoViewer('A "quoted" <title>', '<!doctype html><p onclick="x()">&amp; "q"</p>');
		assert.match(out, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
		assert.match(out, /<iframe sandbox="allow-scripts" title="A &quot;quoted&quot; &lt;title&gt;" srcdoc="/);
		assert.doesNotMatch(out, /allow-same-origin|allow-top-navigation|allow-popups/);
		assert.match(out, /<title>A &quot;quoted&quot; &lt;title&gt;<\/title>/);
		const srcdoc = /srcdoc="([^"]*)"/.exec(out)![1]!;
		assert.ok(!srcdoc.includes('"') && !srcdoc.includes("<"), "the attribute cannot be broken out of");
		const decoded = srcdoc.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
		assert.equal(decoded, buildDemoSrcDoc('<!doctype html><p onclick="x()">&amp; "q"</p>'), "the framed document is exactly the in-app one");
		assert.equal((out.match(/<script/gi) ?? []).length, 0, "the outer page runs nothing itself");
	});
});

describe("the verifier request classifier", () => {
	it("serves only the sandbox document; data:/blob: stay inline; file and network are blocked", () => {
		assert.equal(sandboxRequestKind(DEMO_SANDBOX_URL), "document");
		assert.equal(sandboxRequestKind("data:image/png;base64,AA=="), "inline");
		assert.equal(sandboxRequestKind("blob:https://demo.invalid/abc"), "inline");
		for (const url of [
			"file:///etc/hostname",
			"file:///home/u/.ssh/id_rsa",
			"http://127.0.0.1:3000/api/keys",
			"http://169.254.169.254/latest/meta-data/",
			"https://cdn.jsdelivr.net/npm/d3@7",
			"https://example.com/",
		]) assert.equal(sandboxRequestKind(url), "block", url);
	});
});

describe("policy parity and prompt", () => {
	it("the Electron helper allows exactly the core sandbox URL", () => {
		assert.match(read("../electron/main.cjs"), new RegExp(`const DEMO_SANDBOX_URL = "${DEMO_SANDBOX_URL.replace(/[./]/g, "\\$&")}";`));
	});
	it("the packaged smoke probe serves the same CSP", () => {
		assert.ok(read("../scripts/smoke-demo-runtime.mjs").includes(`const CSP = "${DEMO_CSP}";`));
	});
	it("the demo builder is told there is no network (no CDN allowance)", () => {
		const builder = read("../src/agent/subagents/demo-builder.ts");
		assert.match(builder, /NO network of any kind/);
		assert.doesNotMatch(builder, /CDN imports .* are allowed/);
	});
	it("generated demos no longer load from file://", () => {
		const headless = read("../src/agent/subagents/headless.ts");
		assert.doesNotMatch(headless, /pathToFileURL\(file\)/, "no temp-file demo navigation");
		assert.doesNotMatch(headless, /lh-demo-/, "no temp demo files");
	});
	it("the Chrome fallback never disables the OS sandbox", () => {
		assert.doesNotMatch(read("../src/agent/subagents/headless.ts"), /"--no-sandbox"/);
	});
});
