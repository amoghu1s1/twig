"use client";

import Ansi from "ansi-to-react";
import { AlertTriangleIcon, DownloadIcon, SparklesIcon } from "lucide-react";
import { sanitizeLabHtmlOutput, type LabOutput } from "@/src/core";

export function CellOutputs({
	outputs,
	onOpenImage,
	onDebugError,
}: {
	outputs: readonly LabOutput[];
	onOpenImage?: (url: string) => void;
	onDebugError?: (errorSummary: string) => void;
}) {
	if (outputs.length === 0) return null;

	return (
		<div className="border-t border-border/70 bg-background/60 px-3 py-2.5 space-y-2.5" data-testid="lab-cell-outputs">
			{outputs.map((out, idx) => {
				if (out.outputType === "stream") {
					return (
						<pre
							key={idx}
							className={`m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed ${
								out.name === "stderr" ? "text-error/90" : "text-foreground/90"
							}`}
						>
							<Ansi>{out.text}</Ansi>
						</pre>
					);
				}

				if (out.outputType === "display_data" || out.outputType === "execute_result") {
					const png = out.data["image/png"];
					const svg = out.data["image/svg+xml"];
					const html = out.data["text/html"];
					const plain = out.data["text/plain"];

					if (png) {
						const src = `data:image/png;base64,${png}`;
						return (
							<div key={idx} className="group relative inline-flex max-w-full flex-col items-start gap-1">
								<button
									type="button"
									onClick={() => onOpenImage?.(src)}
									className="block max-w-full cursor-zoom-in overflow-hidden rounded-md border border-border/80 bg-white/95 p-1"
									aria-label="Inspect plot at full size"
								>
									{/* eslint-disable-next-line @next/next/no-img-element */}
									<img src={src} alt="Notebook plot output" className="max-h-96 w-auto max-w-full" />
								</button>
								<a
									href={src}
									download={`lab-plot-${idx + 1}.png`}
									className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
								>
									<DownloadIcon className="size-3" />
									Save PNG
								</a>
							</div>
						);
					}

					if (svg) {
						const safeSvg = sanitizeLabHtmlOutput(svg);
						return (
							<div
								key={idx}
								className="max-w-full overflow-auto rounded-md border border-border/80 bg-white/95 p-2"
								dangerouslySetInnerHTML={{ __html: safeSvg }}
							/>
						);
					}

					if (html) {
						const safeHtml = sanitizeLabHtmlOutput(html);
						return (
							<div
								key={idx}
								className="max-h-80 overflow-auto rounded-md border border-border/70 bg-card/60 p-2 text-xs [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border/70 [&_th]:bg-accent/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium"
								dangerouslySetInnerHTML={{ __html: safeHtml }}
							/>
						);
					}

					if (plain) {
						return (
							<pre
								key={idx}
								className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/85"
							>
								{plain}
							</pre>
						);
					}
					return null;
				}

				if (out.outputType === "error") {
					const tbText = out.traceback.length > 0 ? out.traceback.join("\n") : `${out.ename}: ${out.evalue}`;
					return (
						<div key={idx} className="rounded-md border border-error/40 bg-error/10 p-2.5" data-testid="lab-cell-error">
							<div className="mb-1.5 flex items-center justify-between gap-2">
								<span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-error">
									<AlertTriangleIcon className="size-3.5 shrink-0" />
									{out.ename}{out.evalue ? `: ${out.evalue}` : ""}
								</span>
								{onDebugError && (
									<button
										type="button"
										onClick={() => onDebugError(tbText)}
										className="inline-flex cursor-pointer items-center gap-1 rounded-sm border border-error/40 bg-card px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
									>
										<SparklesIcon className="size-3 text-error" />
										Debug with mentor
									</button>
								)}
							</div>
							<pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
								<Ansi>{tbText}</Ansi>
							</pre>
						</div>
					);
				}

				return null;
			})}
		</div>
	);
}
