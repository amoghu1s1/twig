"use client";

import type { LhViewPart } from "@/src/core";
import { ImageGallery } from "@/components/image-gallery";

/**
 * The body of a learner's transcript row: text and pictures in the order
 * the learner sent them. Text renders plain, never through the model's
 * LaTeX pipeline ($ stays $). Pictures go through the shared ImageGallery;
 * a picture opens full size on click.
 *
 * Session-attachment images in this app ride `data-attachments` ids (the
 * record holds blobs, never base64); this component is the native image
 * projection for any renderer that already resolved those references to
 * URLs.
 */
export function UserMessageParts({
	parts,
	onOpenImage,
}: {
	parts: readonly LhViewPart[];
	onOpenImage: (url: string) => void;
}) {
	return parts.map((part, i) => {
		const key = part.id ?? i;
		if (part.type === "text") {
			return (
				<div key={key} className="lh-prose whitespace-pre-wrap text-foreground">
					{part.text}
				</div>
			);
		}
		if (part.type !== "image") return null;
		return (
			<ImageGallery
				key={key}
				inline
				onOpenImage={onOpenImage}
				items={[{ url: String(part.url), alt: typeof part.alt === "string" ? part.alt : undefined }]}
			/>
		);
	});
}
