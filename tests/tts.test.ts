import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_TTS_VOICE, elevenLabsBody, parseTtsBody, TTS_MAX_CHARS } from "../src/core/tts.ts";
import { sameOriginTts, synthesizeSpeech, TtsError } from "../src/server/tts.ts";

describe("parseTtsBody", () => {
	it("defaults: first voice, flash model, normal rate; text is trimmed", () => {
		const r = parseTtsBody({ text: "  先按顺序数。 " });
		assert.ok(r.ok);
		assert.deepEqual(r.request, { text: "先按顺序数。", voice: DEFAULT_TTS_VOICE, model: "flash", rate: 1 });
	});

	it("rejects bad bodies", () => {
		const cases: unknown[] = [
			null,
			[],
			{},
			{ text: "   " },
			{ text: 5 },
			{ text: "x".repeat(TTS_MAX_CHARS + 1) },
			{ text: "x", voice: "NotAVoice" },
			{ text: "x", model: "pro" },
			{ text: "x", rate: 0.2 },
			{ text: "x", rate: 1.5 },
			{ text: "x", rate: "fast" },
		];
		for (const body of cases) assert.equal(parseTtsBody(body).ok, false, JSON.stringify(body));
	});
});

describe("elevenLabsBody", () => {
	it("carries the model id and speed", () => {
		assert.deepEqual(elevenLabsBody({ text: "hi", voice: DEFAULT_TTS_VOICE, model: "multilingual", rate: 0.9 }), {
			text: "hi",
			model_id: "eleven_multilingual_v2",
			voice_settings: { speed: 0.9 },
		});
	});
});

describe("sameOriginTts — the route's browser-intent gate", () => {
	const post = (headers: Record<string, string> = {}) =>
		new Request("http://localhost:3000/api/tts", { method: "POST", headers });

	it("a same-origin browser POST passes", () => {
		assert.equal(
			sameOriginTts(post({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })),
			true,
		);
	});

	it("cross-site origins, missing origin, spoofed hosts and foreign sec-fetch are 403 material", () => {
		const cases: Record<string, string>[] = [
			{},
			{ host: "localhost:3000" },
			{ host: "localhost:3000", origin: "https://attacker.invalid" },
			{ host: "attacker.invalid", origin: "http://localhost:3000" },
			{ host: "localhost:3000", origin: "null" },
			{ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
		];
		for (const headers of cases) assert.equal(sameOriginTts(post(headers)), false, JSON.stringify(headers));
	});
});

describe("synthesizeSpeech", () => {
	const saved = process.env.ELEVENLABS_API_KEY;
	afterEach(() => {
		if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
		else process.env.ELEVENLABS_API_KEY = saved;
	});
	const req = { text: "hi", voice: DEFAULT_TTS_VOICE, model: "flash", rate: 1 } as const;
	const status = (code: number, body: unknown = {}) =>
		(async () => new Response(JSON.stringify(body), { status: code })) as unknown as typeof fetch;

	it("a missing key never calls the provider (the browser voice is the fallback)", async () => {
		delete process.env.ELEVENLABS_API_KEY;
		let calls = 0;
		const spying = (async () => {
			calls++;
			return new Response("");
		}) as unknown as typeof fetch;
		await assert.rejects(() => synthesizeSpeech(req, spying), (e: unknown) => e instanceof TtsError && e.status === 503 && /ELEVENLABS_API_KEY/.test(e.message));
		assert.equal(calls, 0);
	});

	it("sends the key header to the voice's endpoint and returns the audio", async () => {
		process.env.ELEVENLABS_API_KEY = "test-key-123456789012345";
		let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
		const fake = (async (url: string, init: RequestInit) => {
			seen = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
			return new Response(new Uint8Array([1, 2, 3]));
		}) as unknown as typeof fetch;
		const audio = await synthesizeSpeech(req, fake);
		assert.deepEqual([...audio.bytes], [1, 2, 3]);
		assert.equal(audio.mime, "audio/mpeg");
		assert.equal(seen?.headers["xi-api-key"], "test-key-123456789012345");
		assert.match(seen?.url ?? "", new RegExp(`/v1/text-to-speech/${DEFAULT_TTS_VOICE}\\?output_format=mp3_44100_128$`));
		assert.match(seen?.body ?? "", /eleven_flash_v2_5/);
	});

	it("maps 429 to 429, other failures and empty audio to 502, with the API's detail", async () => {
		process.env.ELEVENLABS_API_KEY = "test-key-123456789012345";
		await assert.rejects(
			() => synthesizeSpeech(req, status(429, { detail: { message: "quota exceeded" } })),
			(e: unknown) => e instanceof TtsError && e.status === 429 && e.message.includes("quota exceeded"),
		);
		await assert.rejects(() => synthesizeSpeech(req, status(401, { detail: "bad key" })), (e: unknown) => e instanceof TtsError && e.status === 502 && e.message.includes("bad key"));
		await assert.rejects(
			() => synthesizeSpeech(req, (async () => new Response(new Uint8Array())) as unknown as typeof fetch),
			(e: unknown) => e instanceof TtsError && e.status === 502,
		);
	});
});
