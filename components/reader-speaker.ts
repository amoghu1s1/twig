/**
 * Read-aloud for the sentence reader (owner, 2026-10-21; opt-in adaptation):
 * the browser's built-in speechSynthesis is the DEFAULT; the ElevenLabs proxy
 * (POST /api/tts — the key stays server-side) is reached only when the learner
 * opts in (prefs.cloud). Any cloud failure (no key, quota, network) sets
 * cloudFailure once and the browser voice carries on. Buffers are decoded
 * through Web Audio; the decode cache is CAPPED (oldest evicted) so a long
 * session never grows without bound. postTts/decode/play are injection seams
 * (tests); nodes use their defaults.
 */

export const READER_CACHE_MAX = 12;

export interface SpeakerSettings {
	voice: string;
	rate: number;
	/** Opt in to the ElevenLabs proxy instead of the built-in browser voice. */
	cloud: boolean;
}

export type SpeakerEngine = "cloud" | "browser";

export interface SpeakerSeams {
	/** The server proxy call → raw MP3 bytes (injected by tests). */
	postTts?: (text: string, s: SpeakerSettings) => Promise<ArrayBuffer>;
	/** MP3 bytes → a playable buffer (injected by tests). */
	decode?: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
	/** Play one decoded buffer; resolves when it ends or is replaced. */
	play?: (buffer: AudioBuffer) => Promise<void>;
}

/** The default proxy implementation: POST /api/tts, errors surfaced as
 *  messages (a JSON body) or a bare status, bytes on success. */
export const defaultPostTts = async (text: string, s: SpeakerSettings): Promise<ArrayBuffer> => {
	const res = await fetch("/api/tts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, voice: s.voice, rate: s.rate }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(body.message ?? `TTS failed (${res.status})`);
	}
	return res.arrayBuffer();
};

export class ReaderSpeaker {
	private ctx: AudioContext | null = null;
	private source: AudioBufferSourceNode | null = null;
	/** Recency-ordered decoded buffers (touch on use); the stalest entry is
	 *  evicted once the cap is passed. */
	private cache = new Map<string, Promise<AudioBuffer>>();
	private token = 0;
	/** Set once ElevenLabs failed this session; the browser voice is used from then on. */
	cloudFailure: string | null = null;

	constructor(private seams: SpeakerSeams = {}) {}

	engine(): SpeakerEngine {
		return this.cloudFailure === null ? "cloud" : "browser";
	}

	private audioContext(): AudioContext {
		this.ctx ??= new AudioContext();
		return this.ctx;
	}

	private load(text: string, s: SpeakerSettings): Promise<AudioBuffer> {
		const key = `${s.voice}|${s.rate}|${text}`;
		let hit = this.cache.get(key);
		if (!hit) {
			hit = this.decodeBuffer(text, s);
			this.cache.set(key, hit);
			hit.catch(() => this.cache.delete(key));
		} else {
			// Touch: a sentence the learner steps back to (K) is live recency —
			// it must not be the next thing evicted.
			this.cache.delete(key);
			this.cache.set(key, hit);
		}
		// THE CAP (owner decision): past it, the stalest entry is evicted, so a
		// long session stays bounded — and shared fetches keep their decode.
		while (this.cache.size > READER_CACHE_MAX) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		return hit;
	}

	private async decodeBuffer(text: string, s: SpeakerSettings): Promise<AudioBuffer> {
		const bytes = this.seams.postTts ? await this.seams.postTts(text, s) : await defaultPostTts(text, s);
		return this.seams.decode ? this.seams.decode(bytes) : await this.audioContext().decodeAudioData(bytes);
	}

	/** Warm the cache for the sentence after the current one (cloud only —
	 *  the browser voice has no fetch round-trip to hide). */
	prefetch(text: string, s: SpeakerSettings): void {
		if (!s.cloud || this.cloudFailure !== null || text === "") return;
		void this.load(text, s).catch(() => {});
	}

	stop(): void {
		this.token++;
		try {
			this.source?.stop();
		} catch {
			// Already ended.
		}
		this.source = null;
		if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
	}

	/** Speak `text`, replacing anything playing. Resolves when it ends (or is
	 *  replaced). Browser speech whenever the cloud path is off or failed. */
	async speak(text: string, s: SpeakerSettings): Promise<void> {
		this.stop();
		if (text === "") return;
		const mine = this.token;
		if (s.cloud && this.cloudFailure === null) {
			try {
				const buffer = await this.load(text, s);
				if (mine !== this.token) return;
				await this.playBuffer(buffer);
				return;
			} catch (err) {
				if (mine !== this.token) return;
				this.cloudFailure = err instanceof Error ? err.message : "TTS failed";
			}
		}
		await this.speakWithBrowser(text, s, mine);
	}

	private async playBuffer(buffer: AudioBuffer): Promise<void> {
		if (this.seams.play) return this.seams.play(buffer);
		const ctx = this.audioContext();
		if (ctx.state === "suspended") await ctx.resume();
		await new Promise<void>((resolve) => {
			const node = ctx.createBufferSource();
			node.buffer = buffer;
			node.connect(ctx.destination);
			node.onended = () => resolve();
			this.source = node;
			node.start();
		});
	}

	private speakWithBrowser(text: string, s: SpeakerSettings, mine: number): Promise<void> {
		return new Promise((resolve) => {
			if (typeof speechSynthesis === "undefined" || mine !== this.token) return resolve();
			if (this.seams.play) return resolve(); // seam mode: the browser path is only exercised for its token bookkeeping
			const u = new SpeechSynthesisUtterance(text);
			u.rate = s.rate;
			u.onend = () => resolve();
			u.onerror = () => resolve();
			speechSynthesis.speak(u);
		});
	}
}
