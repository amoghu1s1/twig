import {
	buildJsRunnerDocument,
	createJsRuntime,
	parseJsRunnerReply,
	type JsRunnerReply,
	type JsRunnerTransport,
	type JsRuntime,
} from "@/src/core";

/**
 * The browser transport for the JavaScript runner (js-runtime.ts): a
 * zero-size sandboxed iframe (sandbox="allow-scripts", no
 * allow-same-origin → opaque origin) holding the runner document. Replies
 * are accepted only from THIS iframe's window.
 */
export function openJsIframeTransport(): JsRunnerTransport {
	const iframe = document.createElement("iframe");
	iframe.setAttribute("sandbox", "allow-scripts");
	iframe.setAttribute("aria-hidden", "true");
	iframe.tabIndex = -1;
	iframe.style.cssText = "position:fixed;width:0;height:0;border:0;pointer-events:none;";
	iframe.srcdoc = buildJsRunnerDocument();

	const listeners = new Set<(reply: JsRunnerReply) => void>();
	const onMessage = (event: MessageEvent): void => {
		if (event.source !== iframe.contentWindow) return;
		const reply = parseJsRunnerReply(event.data);
		if (reply) for (const listener of listeners) listener(reply);
	};
	window.addEventListener("message", onMessage);
	document.body.appendChild(iframe);

	return {
		post: (message) => iframe.contentWindow?.postMessage(message, "*"),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close: () => {
			window.removeEventListener("message", onMessage);
			listeners.clear();
			iframe.remove();
		},
	};
}

/** A JavaScript (or, after transpilation, TypeScript) runtime backed by the
 *  sandboxed iframe. The iframe is created on the first run. */
export function createBrowserJsRuntime(language: "javascript" | "typescript"): JsRuntime {
	return createJsRuntime({ language, openTransport: () => openJsIframeTransport() });
}
