"use client";
/** The calculator button in the bar under the chat box (stats-bar.tsx). */
import { CalculatorIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { CALCULATOR_TOGGLE_EVENT } from "./calculator-host";

export function CalculatorToggle() {
	return (
		<Hint label="Calculator" action="toggle-calculator">
			<button
				type="button"
				aria-label="Calculator"
				data-testid="calculator-toggle"
				onClick={() => window.dispatchEvent(new CustomEvent(CALCULATOR_TOGGLE_EVENT))}
				className="flex items-center rounded-sm p-1 transition-colors hover:text-foreground"
			>
				<CalculatorIcon className="size-3.5" />
			</button>
		</Hint>
	);
}
