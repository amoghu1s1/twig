import { svgImageSource } from "@/src/core";

export { svgImageSource };

/** Keep generated SVG in an image document, outside the app's CSS and ID scope.
 * This is a display boundary, not a sanitizer for the original SVG download.
 * `onError`: the browser couldn't draw it (malformed SVG). */
export function SvgImage({
	svg,
	className,
	width,
	onError,
}: {
	svg: string;
	className?: string;
	width?: number;
	onError?: () => void;
}) {
	// The source is already an in-memory vector image; no Next image optimization.
	// eslint-disable-next-line @next/next/no-img-element
	return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgImageSource(svg))}`} alt="Figure" className={className} width={width} draggable={false} onError={onError} />;
}
