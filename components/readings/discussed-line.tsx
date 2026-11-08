"use client";

/**
 * THE LESSON'S QUIET LINE for a reading-discussion marker (docs/readings.md
 * §14; owner ruling 2026-10-28): the teacher was told about a Discuss
 * exchange — the learner sees one small centered chrome line at that spot
 * that opens the reading (in the session's tray, else its full page). The
 * Q&A itself is never repeated in the lesson.
 */

import Link from "next/link";
import { MessagesSquareIcon } from "lucide-react";
import type { ReadingDiscussionMarkerDetails } from "@/src/core";
import { useSessionReadings } from "@/components/readings/api";

export function ReadingDiscussedLine({ data }: { data: ReadingDiscussionMarkerDetails }) {
	const seam = useSessionReadings();
	const label = (
		<>
			<MessagesSquareIcon className="size-3" />
			You asked about “{data.readingTitle}”
		</>
	);
	const className = "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground";
	return (
		<div data-testid="reading-discussed-line" className="my-3 flex justify-center font-ui text-xs text-muted-foreground">
			{seam ? (
				<button type="button" onClick={() => seam.open(data.readingId)} className={className}>
					{label}
				</button>
			) : (
				<Link href={`/readings/${data.readingId}`} className={className}>
					{label}
				</Link>
			)}
		</div>
	);
}
