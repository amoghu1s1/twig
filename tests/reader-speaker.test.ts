import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type SpeakerSeams, type SpeakerSettings, defaultPostTts, ReaderSpeaker, READER_CACHE_MAX } from "../components/reader-speaker.ts";

const cloud = { voice: "v1", rate: 1, cloud: true } as const;
const local = { voice: "v1", rate: 1, cloud: false } as const;

describe("ReaderSpeaker — browser speech first, ElevenLabs opt-in", () => {
	it("cloud off (the default) never touches the proxy", async () => {
		let posts = 0;
		const speaker = new ReaderSpeaker({ postTts: async () => { posts++; return new ArrayBuffer(0); } });
		await speaker.speak("hello", local);
		await speaker.speak("", local); // empty text resolves silently, cloud or not
		assert.equal(posts, 0);
		assert.equal(speaker.cloudFailure, null);
		assert.equal(speaker.engine(), "cloud");
	});

	it("an empty cloud speak never fetches either", async () => {
		let posts = 0;
		const speaker = new ReaderSpeaker({ postTts: async () => { posts++; return new ArrayBuffer(0); } });
		await speaker.speak("", cloud);
		assert.equal(posts, 0);
	});

	it("cloud: the proxy audio is decoded once, cached, and played per speak", async () => {
		let decodes = 0;
		let plays = 0;
		const speaker = new ReaderSpeaker({
			postTts: async () => new ArrayBuffer(5),
			decode: async () => { decodes++; return {} as unknown as AudioBuffer; },
			play: async () => { plays++; },
		});
		await speaker.speak("alpha", cloud);
		await speaker.speak("alpha", cloud); // cache hit — no second decode
		assert.equal(decodes, 1);
		assert.equal(plays, 2);
	});

	it("a cloud failure drops to the browser voice and notes the reason once", async () => {
		let plays = 0;
		const speaker = new ReaderSpeaker({ postTts: async () => { throw new Error("quota exceeded"); }, play: async () => { plays++; } });
		await speaker.speak("first sentence", cloud);
		assert.equal(speaker.cloudFailure, "quota exceeded");
		assert.equal(speaker.engine(), "browser");
		assert.equal(plays, 0);
		await speaker.speak("second sentence", cloud); // the browser voice carries on, no throw
		assert.equal(speaker.cloudFailure, "quota exceeded");
	});

	it("stop() invalidates an in-flight speak: late buffers never play", async () => {
		let plays = 0;
		let resolve!: (b: ArrayBuffer) => void;
		const gate = new Promise<ArrayBuffer>((r) => (resolve = r));
		const speaker = new ReaderSpeaker({
			postTts: () => gate,
			decode: async (bytes) => ({ id: bytes.byteLength } as unknown as AudioBuffer),
			play: async () => { plays++; },
		});
		const pending = speaker.speak("slow", cloud);
		speaker.stop();
		resolve(new ArrayBuffer(5));
		await pending;
		assert.equal(plays, 0);
	});

	it("prefetch warms the cloud cache only — never a fresh speaker's failure path", async () => {
		const decodeCalls: string[] = [];
		const seams: SpeakerSeams = {
			postTts: async (text) => new ArrayBuffer(text.length),
			decode: async (bytes) => { decodeCalls.push(String(bytes.byteLength)); return {} as unknown as AudioBuffer; },
			play: async () => {},
		};
		const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
		const speaker = new ReaderSpeaker(seams);
		speaker.prefetch("warm", local); // browser voice has nothing to warm
		await flush();
		assert.equal(decodeCalls.length, 0);
		speaker.prefetch("warm", cloud);
		await flush();
		assert.equal(decodeCalls.length, 1);
		assert.equal(speaker.cloudFailure, null);

		const broken = new ReaderSpeaker({ ...seams, postTts: async () => { throw new Error("down"); } });
		await broken.speak("x", cloud); // trips the failure
		broken.prefetch("later", cloud);
		await flush();
		assert.equal(broken.cloudFailure, "down"); // a tripped speaker stops prefetching
	});
});

describe("ReaderSpeaker — the decode cache cap (owner decision)", () => {
	it("decoded sentences are capped; a just-listened-to sentence keeps costing nothing", async () => {
		const decodeCalls: string[] = [];
		const speaker = new ReaderSpeaker({
			postTts: async (text) => new ArrayBuffer(text.length),
			decode: async (bytes) => { decodeCalls.push(String(bytes.byteLength)); return {} as unknown as AudioBuffer; },
			play: async () => {},
		});
		const speech = (n: number) => `sentence-${String(n).padStart(2, "0")}`;
		const fill = READER_CACHE_MAX;
		for (let i = 0; i < fill; i++) await speaker.speak(speech(i), cloud);
		assert.equal(decodeCalls.length, fill);
		// Under the cap: every sentence stays cached through a second pass.
		for (let i = 0; i < fill; i++) await speaker.speak(speech(i), cloud);
		assert.equal(decodeCalls.length, fill);
		// The cap holds when a new sentence overflows it (the stalest decoding is dropped).
		await speaker.speak(speech(fill), cloud);
		assert.equal(decodeCalls.length, fill + 1);
		// Re-reading the evicted head costs exactly one decode — and repeating it
		// is free again (recency touch), so stepping back stays cheap.
		await speaker.speak(speech(0), cloud);
		assert.equal(decodeCalls.length, fill + 2);
		await speaker.speak(speech(0), cloud);
		assert.equal(decodeCalls.length, fill + 2);
	});
});

describe("defaultPostTts — the /api/tts browser seam", () => {
	const original = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = original;
	});

	it("200 carries the bytes; an error body's message becomes the reason", async () => {
		let body: unknown;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(new Uint8Array([9, 9]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
		}) as typeof fetch;
		const bytes = await defaultPostTts("先按顺序数。", cloud);
		assert.equal(bytes.byteLength, 2);
		assert.deepEqual(body, { text: "先按顺序数。", voice: cloud.voice, rate: cloud.rate });

		globalThis.fetch = (async () => new Response(JSON.stringify({ message: "No ELEVENLABS_API_KEY" }), { status: 503 })) as typeof fetch;
		await assert.rejects(() => defaultPostTts("x", cloud), /No ELEVENLABS_API_KEY/);

		globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
		await assert.rejects(() => defaultPostTts("x", cloud), /TTS failed \(502\)/);
	});
});
