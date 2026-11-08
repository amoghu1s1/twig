/**
 * The researcher's network guard (security hardening, ported from the
 * jacobderechin fork, 2026-11-08): src/agent/tools/net-guard.ts — public
 * addresses only (literal IPs and DNS answers), every redirect hop
 * re-checked, streaming byte cap; and web_fetch's opt-in third-party reader
 * fallback.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { guardedFetch, guardedLookup, isBlockedAddress, netGuardTransport } from "../src/agent/tools/net-guard.ts";
import { createWebTools } from "../src/agent/tools/web.ts";

let server: Server;
let port = 0;
before(async () => {
	server = createServer((_req, res) => res.end("internal secret"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	port = (server.address() as { port: number }).port;
});
after(() => server.close());
afterEach(() => { netGuardTransport.current = undefined; });

const opts = { timeoutMs: 5000, maxBytes: 1024 };

describe("isBlockedAddress", () => {
	it("blocks loopback, private, link-local/metadata, CGNAT, multicast, mapped, NAT64, ULA", () => {
		for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
			"::1", "::", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "fd00::1", "fe80::1", "ff02::1"]) {
			assert.equal(isBlockedAddress(ip), true, ip);
		}
	});
	it("allows public addresses; non-IPs count as blocked", () => {
		for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
		assert.equal(isBlockedAddress("not-an-ip"), true);
	});
});

describe("guardedFetch (real transport)", () => {
	it("refuses literal loopback before connecting", async () => {
		await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, opts), /Blocked: 127\.0\.0\.1/);
		await assert.rejects(guardedFetch(`http://[::1]:${port}/`, opts), /Blocked/);
	});
	it("refuses a hostname that resolves to loopback (the guarded lookup)", async () => {
		await assert.rejects(guardedFetch(`http://localhost:${port}/`, opts), /Blocked: localhost/);
		await new Promise<void>((resolve) => guardedLookup("localhost", {}, (err) => {
			assert.equal((err as { code?: string } | null)?.code, "EBLOCKED");
			resolve();
		}));
	});
	it("refuses non-http(s) schemes and credentialed URLs", async () => {
		await assert.rejects(guardedFetch("file:///etc/passwd", opts), /Only http\(s\)/);
		await assert.rejects(guardedFetch("https://user:pw@example.com/", opts), /credentials/);
	});
});

describe("guardedFetch (stub transport: redirects + cap)", () => {
	it("re-checks every redirect hop — a public page cannot bounce to metadata or loopback", async () => {
		for (const target of ["http://169.254.169.254/latest/meta-data/", `http://[::ffff:127.0.0.1]:${port}/`]) {
			netGuardTransport.current = async (url) =>
				url.hostname === "public.example" ? new Response(null, { status: 302, headers: { location: target } }) : new Response("leak");
			await assert.rejects(guardedFetch("https://public.example/start", opts), /Blocked/, target);
		}
	});
	it("follows public redirects up to the limit, then stops", async () => {
		let hops = 0;
		netGuardTransport.current = async () => { hops++; return new Response(null, { status: 302, headers: { location: `https://public.example/${hops}` } }); };
		await assert.rejects(guardedFetch("https://public.example/0", { ...opts, maxRedirects: 3 }), /Too many redirects/);
		assert.equal(hops, 4);
	});
	it("caps the streamed body even without a Content-Length", async () => {
		netGuardTransport.current = async () => new Response(new ReadableStream({
			start(controller) { for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(512)); controller.close(); },
		}));
		await assert.rejects(guardedFetch("https://public.example/big", opts), /Response too large/);
	});
});

describe("web_fetch reader fallback (opt-in third party)", () => {
	const jsShell = "<html><body><div id=app></div><script>render()</script></body></html>";
	it("off by default: the page URL never reaches r.jina.ai", async () => {
		const seen: string[] = [];
		netGuardTransport.current = async (url) => { seen.push(url.href); return new Response(jsShell, { headers: { "content-type": "text/html" } }); };
		const out = await createWebTools(() => null).web_fetch!.execute!("c", { url: "https://spa.example/" });
		assert.match(String(out.details), /Could not extract readable content/);
		assert.deepEqual(seen, ["https://spa.example/"]);
	});
	it("on: the reader service is consulted", async () => {
		const seen: string[] = [];
		netGuardTransport.current = async (url) => {
			seen.push(url.href);
			return url.hostname === "r.jina.ai"
				? new Response(`Title: x\nMarkdown Content:\n${"Readable text. ".repeat(30)}`)
				: new Response(jsShell, { headers: { "content-type": "text/html" } });
		};
		const out = await createWebTools(() => null, () => true).web_fetch!.execute!("c", { url: "https://spa.example/" });
		assert.match(String(out.details), /Readable text/);
		assert.ok(seen.some((u) => u.startsWith("https://r.jina.ai/")));
	});
	it("web_fetch reports a blocked internal URL as a tool error string", async () => {
		const out = await createWebTools(() => null).web_fetch!.execute!("c", { url: `http://127.0.0.1:${port}/api/keys` });
		assert.match(String(out.details), /web_fetch failed .*Blocked/);
	});
});
