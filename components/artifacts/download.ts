/**
 * Artifact download helpers (release polish, 2026-10-07): the tiny
 * save-a-blob seam shared by the demo + figure cards, plus the filename
 * slug. The slug is pure (test-pinned); downloadFile touches the DOM and
 * only runs on click.
 */

/** Slugify a demo title into a filename stem — lowercase, accents folded,
 *  runs of non-alphanumerics collapsed to "-", trimmed, capped at 64
 *  chars. Empty/fully-symbolic titles fall back to "demo". */
export function slugFilename(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "demo";
}

/** Save text, bytes (or an already-built blob) as a downloaded file. The
 *  blob URL is revoked right after the click — Chromium keeps the download
 *  alive past the revoke. */
export function downloadFile(name: string, content: string | Uint8Array<ArrayBuffer> | Blob, mime: string): void {
	const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}

/** Rasterize a figure to PNG IN THE BROWSER (security review, 2026-11-08:
 *  the safe default figure export). The SVG is decoded as an <img> — the
 *  browser's secure image mode: no script, no external fetches — then
 *  drawn to a canvas at `scale`× its intrinsic size (900px wide when it
 *  declares none). Only on click. */
export async function svgToPng(svgSource: string, scale = 2): Promise<Blob> {
	const img = new Image();
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgSource)}`;
	await img.decode();
	const width = img.naturalWidth || 900;
	const height = img.naturalHeight || Math.round(width * 0.75);
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(width * scale);
	canvas.height = Math.round(height * scale);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas unavailable");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return new Promise((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))), "image/png"),
	);
}
