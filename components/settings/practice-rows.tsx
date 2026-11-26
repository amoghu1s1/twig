"use client";

import type {
	PracticeCoachingLevel,
	PracticeDepth,
	PracticePresentation,
	PracticeSettings,
} from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect, Toggle, type SettingsCommitResult } from "./controls.tsx";

export function PracticeSettingsRows({
	practice,
	onPracticeChange,
}: {
	practice?: PracticeSettings;
	onPracticeChange: (next: PracticeSettings) => SettingsCommitResult;
}) {
	const coaching: PracticeCoachingLevel = practice?.defaultCoaching ?? "balanced";
	const depth: PracticeDepth = practice?.defaultDepth ?? "adaptive";
	const presentation: PracticePresentation = practice?.defaultPresentation ?? "auto";
	const verify = practice?.defaultVerifySolutions ?? false;

	return (
		<SettingsGroup label="Practice" testid="group-practice">
			<SettingsRow
				label="Default coaching mode"
				hint="How Practice responds when you miss or ask for hints"
				testid="row-practice-coaching"
			>
				<ThinSelect
					value={coaching}
					ariaLabel="Default Practice coaching mode"
					testid="select-practice-coaching"
					onChange={(next) => {
						if (next === "socratic" || next === "balanced" || next === "direct") {
							void onPracticeChange({ ...practice, defaultCoaching: next });
						}
					}}
				>
					<option value="socratic">Socratic (strict tiny hints, never auto-ends)</option>
					<option value="balanced">Balanced (escalates; offers exit after 2–3 tries)</option>
					<option value="direct">Direct (reveals solution after 1 miss)</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Default difficulty & depth"
				hint="Initial problem complexity for new Practice sessions"
				testid="row-practice-depth"
			>
				<ThinSelect
					value={depth}
					ariaLabel="Default Practice depth"
					testid="select-practice-depth"
					onChange={(next) => {
						if (next === "recall" || next === "adaptive" || next === "deep") {
							void onPracticeChange({ ...practice, defaultDepth: next });
						}
					}}
				>
					<option value="recall">Quick recall (short checks &amp; discrimination)</option>
					<option value="adaptive">Adaptive (warm-up → interleaving → retest)</option>
					<option value="deep">Deep multi-step (derivations &amp; composition)</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Default style"
				hint="Abstract theory vs. concrete real-world scenarios"
				testid="row-practice-style"
			>
				<ThinSelect
					value={presentation}
					ariaLabel="Default Practice presentation style"
					testid="select-practice-style"
					onChange={(next) => {
						if (next === "auto" || next === "theory" || next === "applied") {
							void onPracticeChange({ ...practice, defaultPresentation: next });
						}
					}}
				>
					<option value="auto">Auto (vary across problems)</option>
					<option value="theory">Theory (formal &amp; conceptual)</option>
					<option value="applied">Applied (concrete scenarios &amp; debugging)</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Verify solutions by default"
				hint="Sanity-check posed problems with your Cheap model before displaying them"
				testid="row-practice-verify"
			>
				<Toggle
					checked={verify}
					label="Verify Practice solutions by default"
					onChange={(next) => void onPracticeChange({ ...practice, defaultVerifySolutions: next })}
				/>
			</SettingsRow>
		</SettingsGroup>
	);
}
