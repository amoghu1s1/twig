/** Execute the real helper entry with fake Electron; no display or user profile. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { stopBrowserService } from "../scripts/smoke-demo-runtime.mjs";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const requireMain = createRequire(mainFile);

function helperFixture(connected = true, channel = true) {
	let allowAppReady!: () => void;
	const appReady = new Promise<void>((resolve) => { allowAppReady = resolve; });
	let allowReadiness!: () => void;
	const readiness = new Promise<void>((resolve) => { allowReadiness = resolve; });
	const state = {
		quits: 0, exits: [] as number[], windows: 0, readinessCalls: 0, stdinReads: 0, signal: undefined as AbortSignal | undefined,
		userData: undefined as string | undefined,
		permission: undefined as ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | undefined,
		check: undefined as (() => boolean) | undefined,
		beforeRequest: undefined as ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | undefined,
		created: [] as Array<(e: unknown, c: unknown) => void>,
		windowPrefs: [] as unknown[],
	};
	const logs: string[] = [];
	const errors: string[] = [];
	// Match Electron 44's Windows override, not a native pipe.
	const stdin = new Readable({ read() {} });
	stdin.push(null);
	const process = Object.assign(new EventEmitter(), {
		platform: "win32", argv: ["electron", "--browser-service"], env: {},
		connected, channel: channel ? {} : undefined,
	});
	Object.defineProperty(process, "stdin", { get() { state.stdinReads++; return stdin; } });
	const app = {
		setName() {}, commandLine: { appendSwitch() {} }, whenReady: () => appReady,
		setPath(name: string, value: string) { if (name === "userData") state.userData = value; },
		on(event: string, listener: (e: unknown, c: unknown) => void) { if (event === "web-contents-created") state.created.push(listener); },
		quit() { state.quits++; }, exit(code: number) { state.exits.push(code); },
	};
	const session = {
		defaultSession: {
			setPermissionRequestHandler(handler: typeof state.permission) { state.permission = handler; },
			setPermissionCheckHandler(handler: typeof state.check) { state.check = handler; },
			webRequest: { onBeforeRequest(_filter: unknown, handler: typeof state.beforeRequest) { state.beforeRequest = handler; } },
		},
	};
	class FakeWindow {
		constructor(options?: { webPreferences?: unknown }) { state.windows++; state.windowPrefs.push(options?.webPreferences); }
		async loadURL(url: string) { assert.equal(url, "about:blank"); }
	}
	const net = {
		createServer: () => Object.assign(new EventEmitter(), {
			listen(_port: number, _host: string, callback: () => void) { callback(); },
			address: () => ({ port: 54321 }), close(callback: () => void) { callback(); },
		}),
	};
	const waitForBrowserService = (_port: number, { signal }: { signal: AbortSignal }) => {
		state.readinessCalls++;
		state.signal = signal;
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			readiness.then(resolve);
		});
	};
	runInNewContext(mainSource, {
		require: (id: string) => id === "electron" ? { app, BrowserWindow: FakeWindow, session }
			: id === "node:net" ? net
			: id === "./browser-service-readiness.cjs" ? { waitForBrowserService }
			: requireMain(id),
		process, __dirname: dirname(mainFile), AbortController,
		console: { log: (line: string) => logs.push(line), error: (...parts: unknown[]) => errors.push(parts.join(" ")) },
	}, { filename: mainFile });
	return {
		state, logs, errors, stdin, process, allowAppReady, allowReadiness,
		disconnect() { process.connected = false; process.emit("disconnect"); },
	};
}

describe("browser-service IPC-owned lifetime", () => {
	it("ignores synthetic Windows stdin EOF while IPC remains connected", async () => {
		const helper = helperFixture();
		helper.stdin.resume();
		await turn();
		assert.equal(helper.stdin.readableEnded, true);
		assert.equal(helper.state.stdinReads, 0);
		assert.equal(helper.state.quits, 0);
		helper.allowAppReady();
		await turn();
		assert.equal(helper.state.readinessCalls, 1);
		assert.equal(helper.state.signal?.aborted, false);
		helper.allowReadiness();
		await turn();
		assert.deepEqual(helper.logs, ["BROWSER_SERVICE_CDP 54321"]);
		assert.deepEqual(helper.state.exits, []);
		helper.disconnect();
		assert.equal(helper.state.quits, 1);
	});

	it("locks the helper down: throwaway profile, no permissions/popups/navigation, sandbox-only requests", async () => {
		const helper = helperFixture();
		helper.allowAppReady();
		await turn();
		assert.match(helper.state.userData ?? "", /lh-browser-service-/, "userData is a throwaway temp profile");
		// vm-realm objects: compare by value, not prototype.
		assert.equal(JSON.stringify(helper.state.windowPrefs[0]), JSON.stringify({ offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false }));
		let granted: boolean | undefined;
		helper.state.permission!({}, "media", (ok) => { granted = ok; });
		assert.equal(granted, false);
		assert.equal(helper.state.check!(), false);
		const verdict = (url: string) => { let cancel: boolean | undefined; helper.state.beforeRequest!({ url }, (r) => { cancel = r.cancel; }); return cancel; };
		assert.equal(verdict("https://demo.invalid/"), false);
		assert.equal(verdict("data:image/png;base64,AA=="), false);
		assert.equal(verdict("file:///etc/passwd"), true);
		assert.equal(verdict("http://127.0.0.1:3000/api/keys"), true);
		assert.equal(verdict("https://cdn.jsdelivr.net/npm/d3"), true);
		const contents = {
			windowOpen: undefined as undefined | (() => unknown),
			nav: undefined as undefined | ((e: { preventDefault(): void }, t: string) => void),
			onAttach: undefined as undefined | ((e: { preventDefault(): void }) => void),
			setWindowOpenHandler(h: () => unknown) { this.windowOpen = h; },
			on(event: string, h: (e: { preventDefault(): void }, t: string) => void) {
				if (event === "will-navigate") this.nav = h;
				if (event === "will-attach-webview") this.onAttach = h as unknown as typeof this.onAttach;
			},
		};
		helper.state.created[0]!({}, contents);
		assert.equal(JSON.stringify(contents.windowOpen!()), JSON.stringify({ action: "deny" }));
		let prevented = false;
		contents.nav!({ preventDefault: () => { prevented = true; } }, "https://evil.example/");
		assert.equal(prevented, true);
		let webviewPrevented = false;
		contents.onAttach!({ preventDefault: () => { webviewPrevented = true; } });
		assert.equal(webviewPrevented, true);
		helper.process.emit("exit");
		helper.allowReadiness();
	});

	it("disconnect during readiness aborts it, quits once, and never announces", async () => {
		const helper = helperFixture();
		helper.allowAppReady();
		await turn();
		assert.equal(helper.state.readinessCalls, 1);
		helper.disconnect();
		helper.disconnect();
		await turn();
		assert.equal(helper.state.signal?.aborted, true);
		assert.equal(helper.state.quits, 1);
		assert.deepEqual(helper.logs, []);
		assert.deepEqual(helper.errors, []);
		assert.deepEqual(helper.state.exits, []);
		assert.equal(helper.state.stdinReads, 0);
	});

	it("owns disconnect before app.whenReady resolves", async () => {
		const helper = helperFixture();
		helper.disconnect();
		await turn();
		assert.equal(helper.state.quits, 1);
		assert.equal(helper.state.windows, 0);
		assert.deepEqual(helper.logs, []);
	});

	it("fails closed without both a connected IPC channel and connection state", async () => {
		for (const [connected, channel] of [[false, false], [true, false], [false, true]]) {
			const helper = helperFixture(connected, channel);
			await turn();
			assert.deepEqual(helper.state.exits, [1]);
			assert.match(helper.errors.join("\n"), /requires connected parent IPC/);
			assert.equal(helper.state.windows, 0);
			assert.equal(helper.state.readinessCalls, 0);
			assert.equal(helper.state.stdinReads, 0);
			assert.equal(helper.process.listenerCount("disconnect"), 0);
		}
	});
});

describe("browser-service probe cleanup", () => {
	it("requests IPC disconnect and accepts actual exit without a close event", async () => {
		const helper = Object.assign(new EventEmitter(), {
			pid: 123, connected: true, exitCode: null as number | null, signalCode: null,
			disconnect() {
				helper.connected = false;
				queueMicrotask(() => { helper.exitCode = 0; helper.emit("exit", 0, null); });
			},
		});
		assert.deepEqual(await stopBrowserService(helper), { code: 0, signal: null, requested: true });
		assert.equal(helper.listenerCount("exit"), 0);
		assert.equal(helper.listenerCount("error"), 0);
	});

	it("does not label an already-exited helper as parent-requested shutdown", async () => {
		const helper = { pid: 123, connected: false, exitCode: 0, signalCode: null,
			disconnect() { assert.fail("must not request shutdown after early exit"); } };
		assert.deepEqual(await stopBrowserService(helper), { code: 0, signal: null, requested: false });
	});
});
