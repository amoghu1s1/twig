import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * The researcher's network guard (security hardening, ported from the
 * jacobderechin fork, 2026-11-08): web_fetch and web_fetch_pdf reach the
 * PUBLIC internet only. Prompt-injected pages could otherwise point the
 * researcher at the app's own server, the LAN, or cloud metadata
 * (169.254.169.254) and read the answer back.
 *
 *  - http(s) only; literal IPs are checked before connecting;
 *  - hostnames resolve through a guarded lookup INSIDE the connection, so
 *    the address that was checked is the address that is dialed (no DNS
 *    rebinding window) — any private/local answer refuses the request;
 *  - redirects are followed manually (≤ 5) and every hop is re-checked;
 *  - bodies stream with a hard byte cap (declared length never trusted).
 */

// Two lists on purpose: a single BlockList matches IPv4 queries against
// the IPv4-mapped IPv6 rule below (::ffff:0:0/96), blocking every address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8],
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8],
	["169.254.0.0", 16], // link-local + cloud metadata
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved + broadcast
] as const) BLOCKED_V4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 128], // unspecified
	["::1", 128], // loopback
	["::ffff:0:0", 96], // IPv4-mapped
	["64:ff9b::", 96], // NAT64
	["64:ff9b:1::", 48],
	["100::", 64], // discard
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4 (embeds IPv4)
	["fc00::", 7], // unique local
	["fe80::", 10], // link-local
	["ff00::", 8], // multicast
] as const) BLOCKED_V6.addSubnet(network, prefix, "ipv6");

/** Is this literal address private, local, or otherwise non-public? */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return true;
	return family === 4 ? BLOCKED_V4.check(address, "ipv4") : BLOCKED_V6.check(address, "ipv6");
}

const blockedError = (host: string) =>
	Object.assign(new Error(`Blocked: ${host} is a private or local address — only public web pages can be fetched`), { code: "EBLOCKED" });

type LookupCallback = (err: Error | null, address?: string | LookupAddress[], family?: number) => void;

/** net-style lookup that refuses if ANY resolved address is non-public. */
export function guardedLookup(hostname: string, options: { all?: boolean; family?: number } | undefined, callback: LookupCallback): void {
	dnsLookup(hostname, { family: options?.family ?? 0, all: true, verbatim: true }, (err, addresses) => {
		if (err) return callback(err);
		const list = addresses as LookupAddress[];
		if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) return callback(blockedError(hostname));
		if (options?.all) callback(null, list);
		else callback(null, list[0]!.address, list[0]!.family);
	});
}

const agent = new Agent({ connect: { lookup: guardedLookup as never } });

/** Test seam — undefined in production (the guarded undici transport).
 *  Hermetic tests route through their own stub; the per-hop target checks
 *  and the streaming byte cap below still apply on top of it. */
export const netGuardTransport: { current?: (url: URL, init: RequestInit) => Promise<Response> } = {};

export interface GuardedResponse {
	/** Final URL after redirects. */
	url: string;
	status: number;
	statusText: string;
	headers: Headers;
	body: Buffer;
}

export interface GuardedFetchOptions {
	headers?: Record<string, string>;
	timeoutMs: number;
	maxBytes: number;
	maxRedirects?: number;
}

function checkTarget(url: URL): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are supported");
	if (url.username || url.password) throw new Error("URLs with credentials are not fetched");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host) && isBlockedAddress(host)) throw blockedError(host);
}

/** Fetch a public http(s) URL under the guard; throws on any refusal, on a
 *  redirect loop, or when the body exceeds `maxBytes`. */
export async function guardedFetch(input: string, opts: GuardedFetchOptions): Promise<GuardedResponse> {
	const signal = AbortSignal.timeout(opts.timeoutMs);
	let current = new URL(input);
	for (let hop = 0; ; hop++) {
		checkTarget(current);
		const init = { headers: opts.headers, redirect: "manual" as const, signal };
		const resp = netGuardTransport.current
			? await netGuardTransport.current(current, init)
			: ((await undiciFetch(current, { ...init, dispatcher: agent }).catch((err: unknown) => {
					// undici wraps connect failures as "fetch failed": surface the
					// guard's refusal itself so the researcher learns why.
					const cause = (err as { cause?: { code?: string } }).cause;
					throw cause?.code === "EBLOCKED" ? cause : err;
				})) as unknown as Response);
		const location = resp.headers.get("location");
		if (resp.status >= 300 && resp.status < 400 && location) {
			await resp.body?.cancel().catch(() => {});
			if (hop >= (opts.maxRedirects ?? 5)) throw new Error("Too many redirects");
			current = new URL(location, current);
			continue;
		}
		const declared = Number(resp.headers.get("content-length") ?? 0);
		if (declared > opts.maxBytes) {
			await resp.body?.cancel().catch(() => {});
			throw new Error("Response too large");
		}
		const chunks: Buffer[] = [];
		let total = 0;
		if (resp.body) {
			for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
				total += chunk.byteLength;
				if (total > opts.maxBytes) throw new Error("Response too large");
				chunks.push(Buffer.from(chunk));
			}
		}
		return {
			url: current.href,
			status: resp.status,
			statusText: resp.statusText,
			headers: resp.headers,
			body: Buffer.concat(chunks),
		};
	}
}
