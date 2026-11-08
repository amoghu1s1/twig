import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { CalculatorHost } from "@/components/calculator/calculator-host";
import CopyMathAsTex from "@/components/copy-math-as-tex";
import { SYSTEM_MODE_SCRIPT } from "@/src/core";
import { readThemeBoot } from "@/src/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Twig",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// FIRST PAINT (theme wave + light/system wave): the theme's colors (inline
	// vars), the rendered variant (dark/light class) and the raw display mode
	// (data-lh-mode) are server-rendered from the record, so no frame ever
	// shows the wrong theme or a dark flash for a light user. connection():
	// the record and the theme files are per-machine disk state — without it
	// a prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, mode, renderedMode, vars } = readThemeBoot();
	return (
		<html
			lang="en"
			data-lh-mode={mode}
			className={`${renderedMode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<head>
				{/* Pre-paint System resolution (Next's preventing-flash guide):
				    the server cannot know the OS, so this synchronous inline
				    script swaps the class before the first paint when System
				    disagrees with the server's dark default. */}
				<script dangerouslySetInnerHTML={{ __html: SYSTEM_MODE_SCRIPT }} />
			</head>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			{/* The floating calculator (Alt+C or the bar's calculator button). */}
			<CalculatorHost />
			{/* Global copy handler: rendered math pastes as its TeX source. Renders null. */}
			<CopyMathAsTex />
		</body>
		</html>
	);
}
