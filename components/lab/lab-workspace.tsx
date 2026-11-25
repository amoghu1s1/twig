"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { Chat } from "@/components/chat";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { useImageLightbox } from "@/components/image-lightbox";
import { useServerEvent } from "@/components/server-events";
import {
	buildImportStatement,
	createLabCellId,
	extractTopLevelPythonSymbols,
	serializeIpynb,
	type AttachmentRecord,
	type KernelStatus,
	type KernelVariable,
	type LabCell,
	type LabNotebook,
	type LabNudgeLevel,
	type LabOutput,
	type LabSessionMeta,
	type LabStreamEvent,
	type LabWorkspaceFile,
	type LhMessage,
	type PythonEnvInfo,
} from "@/src/core";
import { ExtractModuleDialog } from "./extract-module-dialog";
import { LabBridgeContext } from "./lab-context";
import { LabMilestoneStrip } from "./lab-milestone-strip";
import { LabToolbar } from "./lab-toolbar";
import { NotebookCell, type LabAskPreset } from "./notebook-cell";
import { VariableInspector } from "./variable-inspector";
import { WorkspaceFilesDrawer } from "./workspace-files-drawer";

const SPLIT_PCT_KEY = "lh:lab-split-pct";

function clampSplit(pct: number): number {
	return Math.min(78, Math.max(30, Math.round(pct)));
}

function appendOutput(outputs: LabOutput[], event: LabStreamEvent): LabOutput[] {
	if (event.type === "stream") {
		const next = [...outputs];
		const last = next.at(-1);
		if (last && last.outputType === "stream" && last.name === event.name) {
			next[next.length - 1] = { ...last, text: last.text + event.text };
			return next;
		}
		return [...next, { outputType: "stream", name: event.name, text: event.text }];
	}
	if (event.type === "output") {
		return [...outputs, event.output];
	}
	return outputs;
}

export function LabWorkspace({
	chatId,
	initialTitle,
	initialMeta,
	initialNotebook,
	initialRevision,
	initialKernelStatus,
	initialVariables,
	initialMessages,
	initialError,
	initialConfigured,
	initialPrompt,
	initiallyInFlight,
	initiallyCompacting,
	initialAttachments,
}: {
	chatId: string;
	initialTitle: string;
	initialMeta: LabSessionMeta;
	initialNotebook: LabNotebook;
	initialRevision: string;
	initialKernelStatus: KernelStatus;
	initialVariables: KernelVariable[];
	initialMessages: LhMessage[];
	initialError?: string;
	initialConfigured: boolean;
	initialPrompt?: string;
	initiallyInFlight?: boolean;
	initiallyCompacting?: boolean;
	initialAttachments: AttachmentRecord[];
}) {
	const router = useRouter();
	const [title, setTitle] = useState(initialTitle);
	const [meta, setMeta] = useState<LabSessionMeta>(initialMeta);
	const [notebook, setNotebook] = useState<LabNotebook>(initialNotebook);
	const notebookRef = useRef<LabNotebook>(initialNotebook);
	notebookRef.current = notebook;

	const revisionRef = useRef(initialRevision);
	const dirtyCellIdsRef = useRef<Set<string>>(new Set());
	const dirtyStructureRef = useRef(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const [kernelStatus, setKernelStatus] = useState<KernelStatus>(initialKernelStatus);
	const [variables, setVariables] = useState<KernelVariable[]>(initialVariables);
	const [busyCellId, setBusyCellId] = useState<string | null>(null);
	const [highlightedCellId, setHighlightedCellId] = useState<string | null>(null);
	const [filesOpen, setFilesOpen] = useState(false);
	const [filesRefreshToken, setFilesRefreshToken] = useState(0);
	const [workspaceFiles, setWorkspaceFiles] = useState<LabWorkspaceFile[]>([]);
	const [extractCell, setExtractCell] = useState<LabCell | null>(null);
	const [variablesOpen, setVariablesOpen] = useState(false);
	const [envs, setEnvs] = useState<PythonEnvInfo[]>([]);
	const [envsLoading, setEnvsLoading] = useState(false);
	const [mobileTab, setMobileTab] = useState<"notebook" | "mentor">("notebook");
	const [splitPct, setSplitPct] = useState(60);
	const [promptDraft, setPromptDraft] = useState<{ id: number; text: string } | undefined>(undefined);
	const [saveNotice, setSaveNotice] = useState<string | null>(null);

	const splitDragRef = useRef<{ startX: number; startPct: number; width: number } | null>(null);
	const splitContainerRef = useRef<HTMLDivElement | null>(null);
	const lightbox = useImageLightbox();

	useEffect(() => {
		try {
			const stored = Number(window.localStorage.getItem(SPLIT_PCT_KEY));
			if (Number.isFinite(stored) && stored >= 30 && stored <= 78) setSplitPct(stored);
		} catch {
			// ignore storage errors
		}
	}, []);

	const refreshEnvs = useCallback((refresh = false) => {
		setEnvsLoading(true);
		void fetch(`/api/labs/envs?chatId=${encodeURIComponent(chatId)}${refresh ? "&refresh=1" : ""}`)
			.then((r) => r.json() as Promise<{ envs?: PythonEnvInfo[] }>)
			.then((d) => setEnvs(d.envs ?? []))
			.catch(() => {})
			.finally(() => setEnvsLoading(false));
	}, [chatId]);

	useEffect(() => {
		refreshEnvs(false);
	}, [refreshEnvs]);

	const flushSave = useCallback(async (explicitNotebook?: LabNotebook) => {
		clearTimeout(saveTimerRef.current);
		const target = explicitNotebook ?? notebookRef.current;
		if (!explicitNotebook && dirtyCellIdsRef.current.size === 0 && !dirtyStructureRef.current) return;

		const snapshotDirtyIds = new Set(dirtyCellIdsRef.current);
		try {
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/notebook`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ notebook: target, expectedRevision: revisionRef.current }),
			});
			if (res.status === 409) {
				const conflict = (await res.json()) as { notebook: LabNotebook; revision: string };
				// Merge dirty local cells over server cells so neither mentor inserts nor typing are lost.
				const localById = new Map(target.cells.map((c) => [c.id, c]));
				const mergedCells = conflict.notebook.cells.map((serverCell) => {
					const localCell = localById.get(serverCell.id);
					return localCell && snapshotDirtyIds.has(serverCell.id) ? localCell : serverCell;
				});
				const mergedNotebook: LabNotebook = { ...conflict.notebook, cells: mergedCells };
				revisionRef.current = conflict.revision;
				setNotebook(mergedNotebook);
				notebookRef.current = mergedNotebook;
				const retry = await fetch(`/api/labs/${encodeURIComponent(chatId)}/notebook`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ notebook: mergedNotebook, expectedRevision: conflict.revision }),
				});
				if (retry.ok) {
					const okData = (await retry.json()) as { revision: string };
					revisionRef.current = okData.revision;
					dirtyCellIdsRef.current.clear();
					dirtyStructureRef.current = false;
					setSaveNotice(null);
				}
				return;
			}
			if (res.ok) {
				const okData = (await res.json()) as { revision: string };
				revisionRef.current = okData.revision;
				dirtyCellIdsRef.current.clear();
				dirtyStructureRef.current = false;
				setSaveNotice(null);
			}
		} catch {
			setSaveNotice("Failed to save notebook — retrying on next edit.");
		}
	}, [chatId]);

	const scheduleSave = useCallback(() => {
		clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			void flushSave();
		}, 450);
	}, [flushSave]);

	useEffect(() => {
		const onHide = () => {
			void flushSave();
		};
		window.addEventListener("pagehide", onHide);
		return () => {
			window.removeEventListener("pagehide", onHide);
			clearTimeout(saveTimerRef.current);
		};
	}, [flushSave]);

	const fetchLatestNotebook = useCallback(async (focusCellId?: string) => {
		try {
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/notebook`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				meta: LabSessionMeta;
				notebook: LabNotebook;
				revision: string;
				kernelStatus: KernelStatus;
				variables: KernelVariable[];
			};
			setMeta(data.meta);
			setKernelStatus(data.kernelStatus);
			setVariables(data.variables);
			if (data.revision !== revisionRef.current) {
				const localById = new Map(notebookRef.current.cells.map((c) => [c.id, c]));
				const dirtyIds = dirtyCellIdsRef.current;
				const mergedCells = data.notebook.cells.map((srv) => {
					const loc = localById.get(srv.id);
					return loc && dirtyIds.has(srv.id) ? loc : srv;
				});
				revisionRef.current = data.revision;
				setNotebook({ ...data.notebook, cells: mergedCells });
			}
			if (focusCellId) {
				setMobileTab("notebook");
				setHighlightedCellId(focusCellId);
				requestAnimationFrame(() => {
					document.getElementById(`lab-cell-${focusCellId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
				});
				setTimeout(() => setHighlightedCellId((cur) => (cur === focusCellId ? null : cur)), 2000);
			}
		} catch {
			// ignore transient sync blips
		}
	}, [chatId]);

	useServerEvent("lab-changed", (event) => {
		if (event.chatId !== chatId) return;
		if (event.revision && event.revision === revisionRef.current && !event.focusCellId) return;
		void fetchLatestNotebook(event.focusCellId);
	});

	const updateCell = useCallback(
		(cellId: string, updater: (prev: LabCell) => LabCell) => {
			dirtyCellIdsRef.current.add(cellId);
			setNotebook((prev) => ({
				...prev,
				cells: prev.cells.map((c) => (c.id === cellId ? updater(c) : c)),
			}));
			scheduleSave();
		},
		[scheduleSave],
	);

	const insertCell = useCallback(
		(cellType: "code" | "markdown", afterCellId?: string) => {
			const cell: LabCell = {
				id: createLabCellId(),
				cellType,
				role: cellType === "markdown" ? "markdown" : "code",
				author: "learner",
				learnerEdited: cellType === "code",
				source: "",
				executionCount: null,
				outputs: [],
			};
			dirtyStructureRef.current = true;
			setNotebook((prev) => {
				const idx = afterCellId ? prev.cells.findIndex((c) => c.id === afterCellId) : -1;
				const nextCells = [...prev.cells];
				if (idx === -1) nextCells.push(cell);
				else nextCells.splice(idx + 1, 0, cell);
				return { ...prev, cells: nextCells };
			});
			scheduleSave();
			return cell.id;
		},
		[scheduleSave],
	);

	const moveCell = useCallback(
		(cellId: string, delta: -1 | 1) => {
			dirtyStructureRef.current = true;
			setNotebook((prev) => {
				const idx = prev.cells.findIndex((c) => c.id === cellId);
				const nextIdx = idx + delta;
				if (idx < 0 || nextIdx < 0 || nextIdx >= prev.cells.length) return prev;
				const nextCells = [...prev.cells];
				const [moved] = nextCells.splice(idx, 1);
				nextCells.splice(nextIdx, 0, moved!);
				return { ...prev, cells: nextCells };
			});
			scheduleSave();
		},
		[scheduleSave],
	);

	const deleteCell = useCallback(
		(cellId: string) => {
			dirtyStructureRef.current = true;
			setNotebook((prev) => {
				if (prev.cells.length <= 1) return prev;
				return { ...prev, cells: prev.cells.filter((c) => c.id !== cellId) };
			});
			scheduleSave();
		},
		[scheduleSave],
	);

	const runCell = useCallback(
		async (cellId: string) => {
			const target = notebookRef.current.cells.find((c) => c.id === cellId);
			if (!target || target.cellType !== "code") return;

			await flushSave();
			setBusyCellId(cellId);
			setKernelStatus("busy");
			setNotebook((prev) => ({
				...prev,
				cells: prev.cells.map((c) =>
					c.id === cellId ? { ...c, outputs: [], checkResult: undefined } : c,
				),
			}));

			try {
				const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/execute`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						cellId,
						code: target.source,
						markLearnerEdited: target.learnerEdited,
					}),
				});
				if (!res.ok || !res.body) {
					throw new Error("Execution request failed");
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					const frames = buf.split("\n\n");
					buf = frames.pop() ?? "";
					for (const frame of frames) {
						const line = frame
							.split("\n")
							.find((l) => l.startsWith("data: "));
						if (!line) continue;
						let ev: LabStreamEvent;
						try {
							ev = JSON.parse(line.slice(6)) as LabStreamEvent;
						} catch {
							continue;
						}
						if (ev.type === "status") {
							setKernelStatus(ev.status);
						} else if (ev.type === "stream" || ev.type === "output") {
							setNotebook((prev) => ({
								...prev,
								cells: prev.cells.map((c) =>
									c.id === cellId ? { ...c, outputs: appendOutput(c.outputs, ev) } : c,
								),
							}));
						} else if (ev.type === "check_result") {
							setNotebook((prev) => ({
								...prev,
								cells: prev.cells.map((c) =>
									c.id === cellId ? { ...c, checkResult: ev.result } : c,
								),
							}));
						} else if (ev.type === "done") {
							setVariables(ev.variables);
							if (ev.revision) revisionRef.current = ev.revision;
							dirtyCellIdsRef.current.delete(cellId);
							setNotebook((prev) => ({
								...prev,
								cells: prev.cells.map((c) =>
									c.id === cellId
										? {
												...c,
												executionCount: ev.executionCount,
												durationMs: ev.durationMs,
												...(ev.sourceHashAtRun !== undefined ? { sourceHashAtRun: ev.sourceHashAtRun } : {}),
												...(ev.lastExecutedAt !== undefined ? { lastExecutedAt: ev.lastExecutedAt } : {}),
												...(ev.failedRunCount !== undefined ? { failedRunCount: ev.failedRunCount } : {}),
												...(c.role === "predict" && c.prediction
													? { prediction: { ...c.prediction, revealed: true } }
													: {}),
										  }
										: c,
								),
							}));
						} else if (ev.type === "kernel_error") {
							setKernelStatus("error");
							setNotebook((prev) => ({
								...prev,
								cells: prev.cells.map((c) =>
									c.id === cellId
										? {
												...c,
												outputs: [
													...c.outputs,
													{ outputType: "error", ename: "KernelError", evalue: ev.message, traceback: [ev.message] },
												],
										  }
										: c,
								),
							}));
						}
					}
				}
			} catch (err) {
				setKernelStatus("error");
				const msg = err instanceof Error ? err.message : "Failed to run cell";
				setNotebook((prev) => ({
					...prev,
					cells: prev.cells.map((c) =>
						c.id === cellId
							? {
									...c,
									outputs: [...c.outputs, { outputType: "error", ename: "KernelError", evalue: msg, traceback: [msg] }],
							  }
							: c,
					),
				}));
			} finally {
				setBusyCellId(null);
			}
		},
		[chatId, flushSave],
	);

	const runAndAdvance = useCallback(
		async (cellId: string) => {
			await runCell(cellId);
			const cells = notebookRef.current.cells;
			const idx = cells.findIndex((c) => c.id === cellId);
			if (idx >= 0 && idx < cells.length - 1) {
				const nextId = cells[idx + 1]!.id;
				document.getElementById(`lab-cell-${nextId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
			} else {
				insertCell("code", cellId);
			}
		},
		[runCell, insertCell],
	);

	const runAll = useCallback(async () => {
		const cells = [...notebookRef.current.cells];
		for (const cell of cells) {
			if (cell.cellType !== "code") continue;
			const locked =
				cell.role === "predict" &&
				cell.prediction !== undefined &&
				cell.prediction.answer === undefined &&
				!cell.prediction.revealed;
			if (locked) continue;
			await runCell(cell.id);
		}
	}, [runCell]);

	const runAllChecks = useCallback(async () => {
		const checks = notebookRef.current.cells.filter((c) => c.role === "check");
		for (const cell of checks) {
			await runCell(cell.id);
		}
	}, [runCell]);

	const interruptKernel = useCallback(async () => {
		await fetch(`/api/labs/${encodeURIComponent(chatId)}/kernel`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "interrupt" }),
		});
	}, [chatId]);

	const restartKernel = useCallback(async () => {
		setKernelStatus("starting");
		const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/kernel`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "restart" }),
		});
		if (res.ok) {
			const data = (await res.json()) as { status: KernelStatus; variables: KernelVariable[] };
			setKernelStatus(data.status);
			setVariables(data.variables ?? []);
		}
	}, [chatId]);

	const refreshVariables = useCallback(async () => {
		const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/kernel`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "inspect_vars" }),
		});
		if (res.ok) {
			const data = (await res.json()) as { variables: KernelVariable[]; status: KernelStatus };
			setVariables(data.variables ?? []);
			setKernelStatus(data.status);
		}
	}, [chatId]);

	const selectInterpreter = useCallback(
		async (interpreterPath: string) => {
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/kernel`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "set_interpreter", interpreterPath }),
			});
			const data = (await res.json()) as { meta?: LabSessionMeta; status?: KernelStatus; error?: string };
			if (!res.ok) throw new Error(data.error ?? "Could not switch Python environment");
			if (data.meta) setMeta(data.meta);
			if (data.status) setKernelStatus(data.status);
			setVariables([]);
			refreshEnvs(true);
		},
		[chatId, refreshEnvs],
	);

	const changeWorkspaceDir = useCallback(
		async (workspaceDir: string) => {
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/workspace`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ workspaceDir }),
			});
			const data = (await res.json()) as { meta?: LabSessionMeta; notebook?: LabNotebook; error?: string };
			if (!res.ok) throw new Error(data.error ?? "Could not bind workspace folder");
			if (data.meta) setMeta(data.meta);
			if (data.notebook) setNotebook(data.notebook);
			dirtyCellIdsRef.current.clear();
			dirtyStructureRef.current = false;
			setVariables([]);
			setKernelStatus("dead");
		},
		[chatId],
	);

	const renameLab = useCallback(
		async (nextTitle: string) => {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: nextTitle }),
			});
			if (res.ok) {
				const data = (await res.json()) as { title: string };
				setTitle(data.title);
				window.dispatchEvent(new Event("lh:chats-changed"));
			}
		},
		[chatId],
	);

	const changeNudgeLevel = useCallback(
		async (nudgeLevel: LabNudgeLevel) => {
			setMeta((prev) => ({ ...prev, nudgeLevel }));
			try {
				const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/settings`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ nudgeLevel }),
				});
				if (res.ok) {
					const data = (await res.json()) as { meta?: LabSessionMeta };
					if (data.meta) setMeta(data.meta);
				}
			} catch {
				// Revert handled if server sync arrives.
			}
		},
		[chatId],
	);

	const askMentor = useCallback((promptText: string) => {
		setMobileTab("mentor");
		setPromptDraft({ id: Date.now() + Math.random(), text: promptText });
	}, []);

	const askMentorForCell = useCallback(
		(cell: LabCell, idx: number, opts?: { errorSummary?: string; preset?: LabAskPreset }) => {
			const errText = opts?.errorSummary?.trim();
			const errBlock = errText ? `\n\`\`\`\n${errText.slice(0, 800)}\n\`\`\`\n` : "";
			switch (opts?.preset) {
				case "hint":
					askMentor(
						`In Cell ${idx + 1} (id: ${cell.id}), please give me a diagnostic hint/pointer only (without giving away the solution code):${errBlock}`,
					);
					return;
				case "check":
					askMentor(`Looking at Cell ${idx + 1} (id: ${cell.id}) — can you check my work so far?${errBlock}`);
					return;
				case "explain":
					askMentor(`In Cell ${idx + 1} (id: ${cell.id}), can you explain what is happening here and why?`);
					return;
				case "fix":
					askMentor(
						`In Cell ${idx + 1} (id: ${cell.id}), I'm stuck — please show me a concrete fix for this:${errBlock}`,
					);
					return;
				default:
					if (errText) {
						askMentor(
							`In Cell ${idx + 1} (id: ${cell.id}), I hit this error:${errBlock}Can you help me diagnose what is wrong and what to check next?`,
						);
					} else {
						askMentor(`Looking at Cell ${idx + 1} (id: ${cell.id}) — `);
					}
			}
		},
		[askMentor],
	);

	const wrapUpLab = useCallback(() => {
		askMentor(
			"Let's wrap up this Lab session. Please review our notebook cells and milestone results, then call lab_summary with what we accomplished and any follow-up gaps.",
		);
	}, [askMentor]);

	const openExtractDialog = useCallback(
		(cell: LabCell) => {
			setExtractCell(cell);
			void fetch(`/api/labs/${encodeURIComponent(chatId)}/files`)
				.then((r) => (r.ok ? r.json() : null))
				.then((data: { files?: LabWorkspaceFile[] } | null) => {
					if (data?.files) setWorkspaceFiles(data.files);
				})
				.catch(() => {});
		},
		[chatId],
	);

	const handleExtracted = useCallback(
		(info: { cellId: string; relPath: string; replaceWithImport: boolean; importStatement: string }) => {
			setExtractCell(null);
			setFilesRefreshToken((n) => n + 1);
			setFilesOpen(true);
			if (info.replaceWithImport) {
				updateCell(info.cellId, (prev) => ({
					...prev,
					source: info.importStatement,
					learnerEdited: true,
				}));
			}
		},
		[updateCell],
	);

	const insertImportCell = useCallback(
		async (relPath: string) => {
			let symbols: string[] = [];
			try {
				const encoded = relPath.split("/").map(encodeURIComponent).join("/");
				const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files/${encoded}`);
				if (res.ok) {
					const data = (await res.json()) as { content?: string };
					if (typeof data.content === "string") {
						symbols = extractTopLevelPythonSymbols(data.content);
					}
				}
			} catch {
				// Fall back to plain module import if unreadable.
			}
			const stmt = buildImportStatement(relPath, symbols);
			const newId = createLabCellId();
			const cell: LabCell = {
				id: newId,
				cellType: "code",
				role: "code",
				author: "learner",
				learnerEdited: true,
				source: stmt,
				executionCount: null,
				outputs: [],
			};
			dirtyStructureRef.current = true;
			setNotebook((prev) => ({ ...prev, cells: [...prev.cells, cell] }));
			scheduleSave();
			setHighlightedCellId(newId);
			requestAnimationFrame(() => {
				document.getElementById(`lab-cell-${newId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
			});
			setTimeout(() => setHighlightedCellId((cur) => (cur === newId ? null : cur)), 2000);
		},
		[chatId, scheduleSave],
	);

	const jumpToCell = useCallback((cellId: string) => {
		setMobileTab("notebook");
		setHighlightedCellId(cellId);
		requestAnimationFrame(() => {
			document.getElementById(`lab-cell-${cellId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
		});
		setTimeout(() => setHighlightedCellId((cur) => (cur === cellId ? null : cur)), 2000);
	}, []);

	const navigateToRoute = useCallback(
		(href: string) => {
			router.push(href);
		},
		[router],
	);

	return (
		<LabBridgeContext.Provider value={{ jumpToCell, askMentor, navigate: navigateToRoute }}>
			<div className="relative flex h-dvh flex-col overflow-hidden" data-testid="lab-workspace">
				<LabToolbar
					chatId={chatId}
					title={title}
					onRename={renameLab}
					meta={meta}
					kernelStatus={kernelStatus}
					busyCellId={busyCellId}
					envs={envs}
					envsLoading={envsLoading}
					filesOpen={filesOpen}
					variablesOpen={variablesOpen}
					onToggleFiles={() => setFilesOpen((o) => !o)}
					onToggleVariables={() => setVariablesOpen((o) => !o)}
					onRunAll={() => void runAll()}
					onInterrupt={() => void interruptKernel()}
					onRestart={() => void restartKernel()}
					onRefreshEnvs={() => refreshEnvs(true)}
					onSelectInterpreter={selectInterpreter}
					onChangeWorkspaceDir={changeWorkspaceDir}
					onChangeNudgeLevel={changeNudgeLevel}
					onWrapUp={wrapUpLab}
					onDownloadIpynb={() => {
						const stem = slugFilename(title || "lab");
						downloadFile(`${stem}.ipynb`, serializeIpynb(notebookRef.current), "application/x-ipynb+json;charset=utf-8");
					}}
				/>

				{/* Responsive mobile switcher (< lg) */}
				<div className="flex border-b border-border bg-card/50 px-3 py-1.5 lg:hidden">
					<div className="flex w-full rounded-md border border-border/70 bg-background p-0.5 text-xs">
						<button
							type="button"
							onClick={() => setMobileTab("notebook")}
							className={`flex-1 cursor-pointer rounded-sm py-1 uppercase tracking-wider ${
								mobileTab === "notebook" ? "bg-accent text-foreground" : "text-muted-foreground"
							}`}
						>
							Notebook
						</button>
						<button
							type="button"
							onClick={() => setMobileTab("mentor")}
							className={`flex-1 cursor-pointer rounded-sm py-1 uppercase tracking-wider ${
								mobileTab === "mentor" ? "bg-accent text-foreground" : "text-muted-foreground"
							}`}
						>
							Mentor
						</button>
					</div>
				</div>

				<div ref={splitContainerRef} className="flex min-h-0 flex-1 overflow-hidden">
					{/* Left / Notebook Pane */}
					<section
						aria-label="Lab notebook"
						style={{ "--lab-split": `${splitPct}%` } as CSSProperties}
						className={`${
							mobileTab === "notebook" ? "flex w-full lg:w-[var(--lab-split)]" : "hidden lg:flex lg:w-[var(--lab-split)]"
						} min-h-0 min-w-0 shrink-0`}
					>
						<div className="flex min-h-0 w-full">
							<WorkspaceFilesDrawer
								chatId={chatId}
								open={filesOpen}
								onClose={() => setFilesOpen(false)}
								refreshToken={filesRefreshToken}
								onInsertImport={(relPath) => void insertImportCell(relPath)}
							/>

							<div className="flex min-h-0 min-w-0 flex-1 flex-col">
								<LabMilestoneStrip
									notebook={notebook}
									running={busyCellId !== null}
									onJumpToCell={jumpToCell}
									onRunAllChecks={() => void runAllChecks()}
								/>

								<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-3">
									{saveNotice && (
										<p role="status" className="rounded border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning">
											{saveNotice}
										</p>
									)}

									{notebook.cells.map((cell, idx) => (
										<NotebookCell
											key={cell.id}
											cell={cell}
											notebook={notebook}
											index={idx}
											totalCells={notebook.cells.length}
											language={notebook.language}
											running={busyCellId === cell.id}
											highlighted={highlightedCellId === cell.id}
											onChange={(updater) => updateCell(cell.id, updater)}
											onRun={(id) => void runCell(id)}
											onRunAndAdvance={(id) => void runAndAdvance(id)}
											onInterrupt={() => void interruptKernel()}
											onMoveUp={(id) => moveCell(id, -1)}
											onMoveDown={(id) => moveCell(id, 1)}
											onInsertBelow={(id, type) => insertCell(type, id)}
											onDelete={(id) => deleteCell(id)}
											onAskMentor={askMentorForCell}
											onExtractModule={openExtractDialog}
											onOpenImage={lightbox.open}
										/>
									))}

									<div className="flex items-center gap-2 pt-1">
										<button
											type="button"
											onClick={() => insertCell("code")}
											data-testid="lab-add-code-cell"
											className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-border/80 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
										>
											<PlusIcon className="size-3.5" />
											Code
										</button>
										<button
											type="button"
											onClick={() => insertCell("markdown")}
											data-testid="lab-add-markdown-cell"
											className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-border/80 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
										>
											<PlusIcon className="size-3.5" />
											Markdown
										</button>
									</div>
								</div>

								<VariableInspector
									variables={variables}
									open={variablesOpen}
									onToggleOpen={() => setVariablesOpen((o) => !o)}
									onRefresh={() => void refreshVariables()}
								/>
							</div>
						</div>
					</section>

					{/* Resizable split divider */}
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize notebook and mentor panes"
						aria-valuenow={splitPct}
						aria-valuemin={30}
						aria-valuemax={78}
						tabIndex={0}
						onPointerDown={(e) => {
							const width = splitContainerRef.current?.getBoundingClientRect().width ?? 1200;
							e.currentTarget.setPointerCapture(e.pointerId);
							splitDragRef.current = { startX: e.clientX, startPct: splitPct, width };
						}}
						onPointerMove={(e) => {
							if (!splitDragRef.current) return;
							const deltaPct = ((e.clientX - splitDragRef.current.startX) / splitDragRef.current.width) * 100;
							setSplitPct(clampSplit(splitDragRef.current.startPct + deltaPct));
						}}
						onPointerUp={(e) => {
							if (!splitDragRef.current) return;
							const deltaPct = ((e.clientX - splitDragRef.current.startX) / splitDragRef.current.width) * 100;
							const finalPct = clampSplit(splitDragRef.current.startPct + deltaPct);
							splitDragRef.current = null;
							setSplitPct(finalPct);
							try {
								window.localStorage.setItem(SPLIT_PCT_KEY, String(finalPct));
							} catch {
								// ignore
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "ArrowLeft") setSplitPct((p) => clampSplit(p - 2));
							else if (e.key === "ArrowRight") setSplitPct((p) => clampSplit(p + 2));
						}}
						className="hidden w-1.5 shrink-0 cursor-col-resize touch-none border-x border-border/50 bg-background transition-colors hover:bg-border lg:block"
					/>

					{/* Right / Mentor Pane */}
					<section
						aria-label="Twig mentor"
						className={`${
							mobileTab === "mentor" ? "flex w-full" : "hidden lg:flex"
						} min-h-0 min-w-0 flex-1 flex-col`}
					>
						<Chat
							chatId={chatId}
							title={title}
							kind="lab"
							embedded
							externalPromptDraft={promptDraft}
							initialMessages={initialMessages}
							initialError={initialError}
							initialConfigured={initialConfigured}
							initialPrompt={initialPrompt}
							initiallyInFlight={initiallyInFlight}
							initiallyCompacting={initiallyCompacting}
							initialAttachments={initialAttachments}
						/>
					</section>
				</div>

				<ExtractModuleDialog
					open={extractCell !== null}
					chatId={chatId}
					cell={extractCell}
					existingFiles={workspaceFiles}
					onClose={() => setExtractCell(null)}
					onExtracted={handleExtracted}
				/>
				{lightbox.lightbox}
			</div>
		</LabBridgeContext.Provider>
	);
}
