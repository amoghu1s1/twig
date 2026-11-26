import {
	chainsForSelection,
	formatChainLine,
	neighborContextForSelection,
	newGraphContextMessage,
	newMistakesContextMessage,
	normalizePracticeMeta,
	resolveSettings,
	type ChatListItem,
	type GraphContextPick,
	type LabLanguage,
	type LabSessionMeta,
	type LhMessage,
	type MistakeSeedItem,
	type PracticeSessionMeta,
} from "@/src/core";
import {
	compactionInFlight,
	createChat,
	isTurnRunning,
	listChats,
	provisionLabWorkspace,
	readSettingsRecord,
	stores,
	titleFromPrompt,
} from "@/src/server";

export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

function parseMistakeSeeds(raw: unknown): MistakeSeedItem[] {
	if (!Array.isArray(raw)) return [];
	const out: MistakeSeedItem[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const r = item as Record<string, unknown>;
		if (typeof r.id !== "string" || typeof r.question !== "string" || !r.question.trim()) continue;
		out.push({
			id: r.id,
			question: r.question,
			...(typeof r.errorType === "string" && r.errorType ? { errorType: r.errorType } : {}),
			...(typeof r.topic === "string" && r.topic ? { topic: r.topic } : {}),
			...(typeof r.whatYouDid === "string" && r.whatYouDid ? { whatYouDid: r.whatYouDid } : {}),
			...(typeof r.rule === "string" && r.rule ? { rule: r.rule } : {}),
			...(typeof r.sessionTitle === "string" && r.sessionTitle ? { sessionTitle: r.sessionTitle } : {}),
		});
		if (out.length >= 15) break;
	}
	return out;
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as {
		title?: unknown;
		kind?: unknown;
		graphContext?: unknown;
		mistakesContext?: unknown;
		practice?: unknown;
		lab?: unknown;
	};
	const title = typeof body.title === "string" ? body.title : "";
	if (body.kind === "capstone") {
		return Response.json({ error: 'Capstone sessions are retired; use kind "lab".' }, { status: 400 });
	}
	const kind = body.kind === "practice" || body.kind === "lab" ? body.kind : undefined;
	const resolvedTitle = titleFromPrompt(title || (kind === "lab" ? "Untitled lab" : "Untitled session"));

	let labMeta: LabSessionMeta | undefined;
	if (kind === "lab") {
		const rawLab = body.lab && typeof body.lab === "object" && !Array.isArray(body.lab)
			? (body.lab as { workspaceDir?: unknown; interpreterPath?: unknown; language?: unknown })
			: {};
		const workspaceDir = typeof rawLab.workspaceDir === "string" && rawLab.workspaceDir.trim() ? rawLab.workspaceDir.trim() : undefined;
		const interpreterPath = typeof rawLab.interpreterPath === "string" && rawLab.interpreterPath.trim() ? rawLab.interpreterPath.trim() : undefined;
		const language: LabLanguage = rawLab.language === "python" ? "python" : "python";
		try {
			const provisioned = await provisionLabWorkspace({
				title: resolvedTitle,
				workspaceDir,
				interpreterPath,
				language,
			});
			labMeta = provisioned.meta;
		} catch (err) {
			return Response.json(
				{ error: err instanceof Error ? err.message : "Could not provision Lab workspace" },
				{ status: 400 },
			);
		}
	}

	let practiceMeta: PracticeSessionMeta | undefined;
	if (kind === "practice") {
		const effective = resolveSettings(readSettingsRecord());
		const defaults: PracticeSessionMeta = {
			coaching: effective.practice.defaultCoaching,
			depth: effective.practice.defaultDepth,
			presentation: effective.practice.defaultPresentation,
			verifySolutions: effective.practice.defaultVerifySolutions,
		};
		const rawPractice = body.practice && typeof body.practice === "object" && !Array.isArray(body.practice)
			? (body.practice as Partial<PracticeSessionMeta>)
			: undefined;
		practiceMeta = normalizePracticeMeta(rawPractice, defaults);
	}

	const chat = createChat(
		resolvedTitle,
		kind,
		labMeta ? { lab: labMeta } : practiceMeta ? { practice: practiceMeta } : undefined,
	);
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}

	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
					(p): p is GraphContextPick =>
						typeof p === "object" &&
						p !== null &&
						typeof (p as GraphContextPick).id === "string" &&
						typeof (p as GraphContextPick).name === "string" &&
						typeof (p as GraphContextPick).statement === "string",
				)
				.slice(0, 64)
		: [];

	const initialMessages: LhMessage[] = [];
	if (picks.length > 0) {
		const allNodes = stores.graphStore.readNodes();
		const allChains = stores.graphStore.readChains();
		const byId = new Map(allNodes.map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, allChains).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		if (kind === "practice") {
			const { neighbors, neighborChains } = neighborContextForSelection(pickedNodes, allNodes, allChains, 12);
			initialMessages.push(newGraphContextMessage(picks, chainLines, neighbors, neighborChains));
		} else {
			initialMessages.push(newGraphContextMessage(picks, chainLines));
		}
	}

	if (kind === "practice") {
		const mistakeSeeds = parseMistakeSeeds(body.mistakesContext);
		if (mistakeSeeds.length > 0) {
			initialMessages.push(newMistakesContextMessage(mistakeSeeds));
		}
	}

	if (initialMessages.length > 0) {
		stores.chatStore.saveMessages(chat.id, initialMessages);
	}

	return Response.json({
		id: chat.id,
		title: chat.title,
		...(chat.lab ? { lab: chat.lab } : {}),
		...(chat.practice ? { practice: chat.practice } : {}),
	});
}
