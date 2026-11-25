import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { LabWorkspace } from "@/components/lab/lab-workspace";
import { createEmptyLabNotebook, isLegacyCapstone, slotsConfigured } from "@/src/core";
import {
	compactionInFlight,
	getChat,
	getLabKernelState,
	isTurnRunning,
	readLabNotebook,
	readSettingsRecord,
	turnFailure,
} from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) notFound();
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();

	if (chat.kind === "lab" && chat.lab) {
		let initialNotebook = createEmptyLabNotebook(chat.title);
		let initialRevision = "";
		try {
			const snap = readLabNotebook(chat.lab);
			initialNotebook = snap.notebook;
			initialRevision = snap.revision;
		} catch {
			// Fall back to an empty scaffold if the notebook file is missing;
			// the workspace UI allows rebinding or recreating on edit.
		}
		const kernel = getLabKernelState(chat.id);
		return (
			<LabWorkspace
				key={chat.id}
				chatId={chat.id}
				initialTitle={chat.title}
				initialMeta={chat.lab}
				initialNotebook={initialNotebook}
				initialRevision={initialRevision}
				initialKernelStatus={kernel.status}
				initialVariables={kernel.variables}
				initialMessages={chat.messages}
				initialError={turnFailure(chat.id)}
				initialConfigured={slotsConfigured(record?.models)}
				initialPrompt={prompt}
				initiallyInFlight={isTurnRunning(chat.id)}
				initiallyCompacting={compactionInFlight(chat.id)}
				initialAttachments={chat.attachments ?? []}
			/>
		);
	}

	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			legacyArchived={isLegacyCapstone(chat.kind)}
			// Wave D: the record IS native agent history — the client view is
			// derived app-side (core/view.ts projectView; GET serves the same
			// native messages).
			initialMessages={chat.messages}
			// Notes (notes wave): the record's saved notes — the first paint's
			// text; the controller re-reads on mount (B/F can replay stale).
			initialNotes={chat.notes ?? ""}
			initialError={turnFailure(chat.id)}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
			initialAttachments={chat.attachments ?? []}
		/>
	);
}
