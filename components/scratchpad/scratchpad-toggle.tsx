"use client";
/** The scratchpad button in the bar under the chat box (stats-bar.tsx), next to the calculator's. */
import { PencilLineIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { SCRATCHPAD_TOGGLE_EVENT } from "./scratchpad-host";

export function ScratchpadToggle() {
	return (
		<Hint label="Scratchpad" action="toggle-scratchpad">
			<button
				type="button"
				aria-label="Scratchpad"
				data-testid="scratchpad-toggle"
				onClick={() => window.dispatchEvent(new CustomEvent(SCRATCHPAD_TOGGLE_EVENT))}
				className="flex items-center rounded-sm p-1 transition-colors hover:text-foreground"
			>
				<PencilLineIcon className="size-3.5" />
			</button>
		</Hint>
	);
}
