# Readings — opt-in companion documents

Status: **IMPLEMENTED (P1 + P2), 2026-10-27.** Drafted the same day from a read of the as-built system (`architecture.md`, `vision.md`, `probe-teach-split.md`, `teaching-methodology.md`, the teacher/prober/practice prompts, and the code). Where docs and code disagree this follows the code (practice is a chat kind seeded by graph-context picks; the graph carries no understanding levels since 2026-09-27).

**Rulings taken (2026-10-27):** scope P1 + P2; researched is the default source mode (§11 Q1); readings sit in a side tray beside the lesson (§11 Q8); the teacher gets no marker when a reading is requested (§11 Q2 — stricter than the proposal: the teacher never learns a reading exists). The remaining §11 questions were built at the proposal's defaults and are still open for an owner ruling. See §12 for what was built where.

Supersedes the `curriculum.md` direction: rather than a structure that steers sessions, readings sit **beside** them and never steer anything.

---

## 1. The idea

A **reading** is a learner-facing document the learner opts into: a deeper written treatment of something, produced in the background by a writer agent, from model knowledge or from web research with citations. Four kinds, one mechanism:

| Kind | When | What it is |
|---|---|---|
| **Primer** | before teaching — at plan presentation, or from the new-session screen | the terms the lesson will use, as plain definitions — no derivations |
| **Deep dive** | during a lesson — on a plan node (or a passage) | the fuller story of one idea: history, motivation, edge cases, worked examples, connections beyond the lesson's path |
| **Recap** | any time, typically at the end of a session | what the session actually built, step by step as taught — plus **further reading** |
| **Node reading** | from the knowledge graph — a node, chain, or cluster | a deep dive anchored on graph objects instead of a session |

Readings never change the lesson. The teacher's plan, pacing, and checks are untouched.

---

## 2. Fit with the doctrine

The teaching method is explicit that walls of text don't teach: *"no wall of text that 'covers' the missing ground in one turn"*, *"never build on a step he hasn't demonstrated."* A reading is, by construction, a wall of unverified text. That is acceptable only under rules that keep it out of the teaching loop:

1. **Opt-in, always.** No reading is generated without a learner action (cost and consent). The teacher may *offer* one (§6.2); it never creates one.
2. **Never evidence.** Opening or reading a reading is not a signal that anything is held. The teacher never assumes a reading was read; nothing about readings reaches the graph or any assessment.
3. **Never ahead of the lesson.** A deep dive goes *deeper*, not *further*: it may name that later plan nodes exist but must not explain them — the lesson's order is the teacher's highest-leverage judgment, and a reading that pre-teaches node 5 while the learner is on node 2 hands him loose facts the method exists to avoid.
4. **Proving it goes through the existing formats.** A reading that covers graph propositions offers *Practice this*, which opens a normal practice session on them — the "read, then demonstrate" loop stays in the quiz/problem formats.

Two kinds fit the method particularly well:

- **Primers are definitions-only** — and real definitions are one of the two "especially strong forms of unconditional truth" (teacher/05-method.md, Principle i). A glossary of genuine definitions is ground the lesson can stand on, not a shortcut around it. A "definition" that is really a list of properties, or that needs a derivation, is out of scope for a primer.
- **Recaps consolidate what was already built.** The click is *"loose facts collapsing into generators"*; a recap that lays the session's derivation out as one picture is a durable record of that structure. It's also vision §2's unbuilt idea #6, *"the session compiles to a durable artifact … a personal textbook that grows."*

---

## 3. Source modes

| Mode | How | Label shown on the reading |
|---|---|---|
| **Researched** (proposed default) | writer runs with the researcher's web toolset (`createWebTools`: `web_search`, `web_fetch`; plus the per-run PDF set the researcher gets — `web_fetch_pdf` and the pdf readers, wired in `subagents/runner.ts`) | sources listed; every citation verified (§5.3) |
| **Model only** | writer runs with no tools | "Written from model knowledge — not source-checked" |

The shared accuracy rule (`shared/15-accuracy.md`) applies to both. Researched mode costs more and takes longer; the creation control shows which mode is picked before anything runs. A missing search provider degrades as the researcher already does (fetch-only, stated limitation), never fabricated results.

**Recap** is a special case: its *body* is a faithful summary of the transcript (no research — the session is the source); only its **Further reading** section uses research, and there research is required (a further-reading list from model memory would be invented URLs).

---

## 4. Data model

### 4.1 The record

New domain contract `src/core/contracts/readings.ts`:

```ts
export type ReadingKind = "primer" | "deep-dive" | "recap" | "node";
export type ReadingSourceMode = "researched" | "model";
export type ReadingStatus = "queued" | "writing" | "ready" | "error";

export interface ReadingAnchor {
	/** The session it was asked from (primer, deep-dive, recap). */
	chatId?: string;
	/** Plan-tree slug the deep dive is about — read against the tree version below. */
	planNodeId?: string;
	planVersion?: number;
	/** A specific transcript message (passage deep dives, v2). */
	messageId?: string;
	/** Graph propositions it is about (node readings), frozen at creation. */
	nodeIds?: string[];
}

export interface ReadingSource { title: string; url: string; }

export interface ReadingRecord {
	id: string;
	kind: ReadingKind;
	mode: ReadingSourceMode;
	status: ReadingStatus;
	title: string;
	/** The learner's optional request text ("focus on why it fails for non-convex …"). */
	request?: string;
	anchor: ReadingAnchor;
	/** The context the writer was given, frozen (self-contained, like practice picks). */
	snapshot: ReadingSnapshot;
	/** Markdown + LaTeX + mermaid, the app's standard rendering contract. */
	body?: string;
	/** Sources cited in the body (researched mode). */
	sources?: ReadingSource[];
	/** Recap only: annotated further-reading list, research-verified. */
	furtherReading?: Array<ReadingSource & { why: string; level?: "intro" | "standard" | "advanced" }>;
	/** Recap only: the transcript extent covered — re-running later makes a new version. */
	coversThroughMessageId?: string;
	/** Previous version (recaps regenerated as a session continues; any reading re-run). */
	supersedes?: string;
	error?: string;
	usage?: CallUsage[];
	createdAt: string;
	updatedAt: string;
	schema?: number;
}
```

### 4.2 Self-contained, like practice

The `snapshot` freezes what the writer saw — the plan tree (deep dive), the probe assessment, the propositions' name + statement (node readings), the transcript extent (recap). Later plan rewrites, extractions, or graph deletions never shift the ground under an existing reading (the practice "freezes its world at creation" law).

### 4.3 Storage and ownership

`data/readings/<id>.json`, whole-file JSON. New port `ReadingStore` in `src/core/ports.ts`, adapter `src/store/readings.ts`, instantiated only in `src/server/stores.ts`. **Sole writer: the readings pipeline** (§5). Deleting a session does **not** delete its readings by default (§11 Q6) — they're the learner's documents; an orphaned anchor just loses its back-link.

---

## 5. The writer pipeline

### 5.1 A background stage, not a Workbench job

Teacher jobs (`research`/`demo`/`visual`/`pdf`) are bound to a teacher tool call and deliver by a steer that **wakes the teacher**. Readings must not: they're learner-requested, they're not lesson content, and a reading finishing mid-lesson should never interrupt the teacher. So readings follow the **practice-run pattern** (architecture §7, "registry, not JobRecords"): a `globalThis` run registry row per reading (`reading:<id>`) with its own abort controller and usage accumulation, shown in the activity dock; model calls under the shared background semaphore (`bg-llm-semaphore.ts`, 3 permits). A boot sweep marks stale `writing` records as `error "Interrupted (server restarted)"`.

New model role `writer` — strong slot, in `BACKGROUND_MODEL_ROLES` (per-role override, like the grader).

### 5.2 Agent shape

`src/agent/subagents/reading-writer.ts`: `runSubagent` with the web tools (researched mode) or none (model mode), finishing with a single **`submit_reading`** call on the `runSubmitAgent` seam: `{ title, body, sources[], furtherReading?[] }`. One prompt per kind under `src/agent/prompts/readings/` (base + `primer.md`, `deep-dive.md`, `recap.md`, `node.md`), overridable in settings like the other agents' fragments.

Context is assembled **server-side and deterministically** (no graph tools for the writer — the writer sees exactly the snapshot):

| Kind | Writer receives |
|---|---|
| Primer | the session goal + `probe_done` assessment + the plan tree (if presented yet); or, from the new-session screen, the learner's topic text |
| Deep dive | the anchored plan node + its prerequisites and **which nodes are visited / upcoming** (`derivePlanStatuses`), the probe assessment, the transcript slice that taught the node, the learner's request |
| Recap | the transcript through `coversThroughMessageId` (teacher prose, learner answers + thinking, check outcomes), the plan tree, propositions born in the chat if extraction has run |
| Node | the picked propositions (name + statement) and the stored chains among them (`chainsForSelection` — the practice entry's exact derivation) |

### 5.3 Validation (the `validate` hook — model retries on failure)

- **Citations are real.** Every URL in `sources`/`furtherReading` must appear in this run's successful `web_fetch`/`web_fetch_pdf` log. A URL the writer never fetched is a tool-input error. This is the single most important guard — invented references are the classic failure of AI further-reading lists.
- **Model mode carries no sources** (an empty list is enforced; the label does the honesty).
- **Primer shape**: a list of term → definition entries (the submit schema has a `terms[]` field for primers instead of free `body`, rendered as a glossary).
- **Size bounds** per kind (a primer is short; a deep dive is long but bounded).

Not machine-checkable, so stated in the prompts: no pre-teaching of upcoming nodes (deep dive); recap body contains only what the session taught, in the order it was taught; "where you stumbled" is written from check outcomes and the learner's own thinking, never from guesses.

### 5.4 The recap's structure (prompt-level, sketch)

1. **The goal** — as the probe made it concrete.
2. **Where you started** — the ground the probe found (from the assessment), in one paragraph.
3. **The build** — the unconditional truths first, then each reasoning step as it was actually taught, one short paragraph each, using the learner's own phrasings where he produced them.
4. **The structure** — one mermaid diagram of the derivation (truths at the bottom, goal at the sink): the click, drawn.
5. **Where it took repair** — misses and how they were resolved (from check outcomes + thinking). Kind, factual, short.
6. **Further reading** — 3–8 verified sources, each with *why read this* and a level, ordered from closest to the lesson outward.

---

## 6. Entry points

### 6.1 Learner-initiated (all v1 except where marked)

- **Plan map → node → "Read deeper"** (plan popup and plan window). Optional request text, mode toggle. The reading card lands in the **session's readings tray**, not in the transcript flow — the lesson continues undisturbed.
- **Session top bar → "Recap"**. Sessions have no end event, so a recap is requested whenever the learner wants one; re-requesting later produces a new version covering more (`supersedes`).
- **Plan presentation → "Primer: key terms"** — offered on the plan block once the plan is presented (the moment the terms are known and the probe has shown which are unfamiliar).
- **New-session screen → "Primer first"** — for a topic not yet started (v2: from the topic text alone, no probe).
- **Graph → node / chain-table selection → "Deep dive"** — in the chain table, the browse-mode selection is sources and folders; Deep dive reads every proposition in the selected sources (v2).
- **Passage → "Read deeper on this"** — text selection on teacher prose, anchored by `messageId` (v2).

### 6.2 Teacher-offered (v2)

A `suggest_reading` teacher tool: `{ kind, planNodeId?, title, why }`. It renders an **offer card** (one click to opt in, with mode choice), and nothing is generated unless the learner clicks. Doctrine for the teacher (`teacher/45-readings.md`, sketch): offer when the learner shows curiosity beyond the lesson's path (a detour worth taking *outside* the session), never as a substitute for teaching a step, never more than occasionally.

### 6.3 Does the teacher know?

Proposed (§11 Q2): when the learner requests a session-anchored reading, a one-line **reading marker** joins the transcript at the next turn boundary — "Learner requested a deep dive on ‹node›" — so the teacher can acknowledge curiosity and avoid duplicating it. The reading's *content* never enters the teacher's context (the reading is not lesson material, and the teacher must not assume it was read).

---

## 7. Graph link — derived, never stored in the graph

The graph stays an objective world-model; readings are AI-authored documents, so they are **not** imported as propositions (§11 Q5). The link is a read-time fold:

- A node's detail card lists **Readings**: readings whose `anchor.nodeIds` include it, plus session readings whose `anchor.chatId` is any session in the node's provenance.
- *Practice this* on a reading: the reading's `nodeIds` (node readings) or the propositions born in its anchor chat (session readings, once extracted) → `POST /api/chats { kind: "practice", graphContext: { propositions } }`, the existing practice entry. Hidden when there are no propositions to pass.

---

## 8. UI

- **Reading card** (session tray / library): title, kind, mode label, status with live activity line while writing, cost.
- **Reader**: a side sheet in the session (the lesson stays visible and live behind it) and a full page at `/readings/[id]`. Standard markdown/LaTeX/mermaid rendering, sources as a numbered list, *Practice this*, *Re-run*, *Delete*, export (markdown/HTML via the existing download helper).
- **`/readings`** library: all readings, filter by kind and session, search; sidebar row next to Practice.
- **Graph node card**: "Readings (n)" section + "Deep dive" action (v2).

---

## 9. Placement

| Concern | Lives in |
|---|---|
| Contracts | `src/core/contracts/readings.ts` (new domain) |
| Pure logic | `src/core/readings.ts` — snapshot builders' pure parts, citation check, node→readings fold (browser-safe parts barrel-exported) |
| Port + adapter | `ReadingStore` in `ports.ts`; `src/store/readings.ts`; wired only in `stores.ts` |
| Writer | `src/agent/subagents/reading-writer.ts`; prompts in `src/agent/prompts/readings/` |
| Teacher tool (v2) | `suggest_reading` in `src/agent/tools/readings.ts` |
| Routes | `app/api/readings/route.ts` (POST create → 202 `{id}`, GET list), `[id]/route.ts` (GET, DELETE — aborts a live run first) |
| UI | `components/reading-*.tsx`; plan-popup/plan-window action; top-bar Recap; sidebar row |
| Data skill | `skills/learnharness/scripts/readings.py` + a section in `references/data-format.md` (read-only, same rules) |

The import law is untouched; the extraction pipeline never sees readings (readings live outside `data/chats`).

---

## 10. Phases

### P0 — try it today, no code

Ask the teacher directly mid-lesson ("research X and write me a fuller explanation I can read later") — the existing `research` job returns a sourced brief, and the teacher can relay it. Ask for a recap at the end. This shows what kinds of reading are wanted, and what's missing: the brief is teacher-facing, it lands in the transcript flow, and it isn't kept as a document.

### P1 — the core

Contracts, store, writer pipeline (both modes, citation validator), run registry + activity dock rows, reader side sheet + `/readings` + sidebar row. Entry points: **Read deeper** on plan nodes, **Recap** (with further reading), **Primer** at plan presentation. Data-skill reader.

Done when: a learner mid-lesson opens a node deep dive that writes in the background without touching the lesson, cites only fetched sources, doesn't explain upcoming nodes; a recap reproduces the session's actual build and offers verified further reading; a primer lists real definitions of the plan's terms.

### P2 — wider reach

Graph node/chain readings and the node-card section; *Practice this*; teacher `suggest_reading` + offer card + reading marker; passage selection anchors; primer from the new-session screen; recap versions.

Tests (deterministic, no LLM — the `npm test` discipline): citation validator (unfetched URL, fetched-then-cited, model-mode sources rejected); snapshot builders over synthetic chats (visited/upcoming split for deep dives, recap extent); node→readings fold; route validation; boot-sweep honesty.

---

## 11. Decisions needing an owner ruling

1. **Default source mode** — researched (proposed) vs. model-only vs. ask every time?
2. **Teacher awareness** — request marker only (proposed) vs. nothing vs. the teacher sees the reading's content?
3. **Teacher-offered readings** — should the teacher be allowed to offer them at all (`suggest_reading`), and how often?
4. **Deep-dive scope rule** — strict "deeper, not further" (proposed) vs. allowed to run ahead when the learner explicitly asks?
5. **Graph import** — never (proposed: AI-authored, unread material isn't an encounter) vs. optional "add to my map" through the notes front door?
6. **Lifetime** — do readings outlive their session's deletion (proposed yes) or cascade?
7. **Recap trigger** — learner button only (proposed) vs. also offered automatically when a session goes idle?
8. **Where readings show in a session** — a tray beside the lesson (proposed) vs. cards in the transcript flow?
9. **Personalization** — readings tailored to what the learner holds (proposed for deep dives and primers) vs. always standalone, general articles?
10. **Naming** — "reading", "deep dive", "primer", "recap" are placeholders; the codebase is strict about vocabulary.


---

## 12. As built (2026-10-27)

| Piece | Where |
|---|---|
| Contracts | `src/core/contracts/readings.ts` (exported through the contracts barrel) |
| Pure core | `src/core/readings.ts` — request grammar, snapshot builders, the citation law, node/chat folds, markdown export |
| Port + adapter | `ReadingStore` in `src/core/ports.ts`; `src/store/readings.ts` (`data/readings/<id>.json`, schema-stamped); wired in `src/server/stores.ts` |
| Writer | `src/agent/subagents/readings.ts` — run registry (`__lhReadingRuns`), shared bg semaphore, `runSubmitAgent` with `submit_reading`, instrumented web/pdf tools record successful fetches |
| Prompts | `src/agent/prompts/readings/` (base, `05-researched`/`05-model`, one `10-<kind>` per kind) + shared voice/accuracy/formatting; teacher doctrine `prompts/teacher/45-readings.md` |
| Teacher offer | `suggest_reading` — `src/agent/tools/readings.ts`, always on, record-only |
| Server | `src/server/readings.ts` (create/list/get/delete/abort, boot sweep); activity feed rows + `kind: "reading"` abort; `readings-changed` event |
| Routes | `app/api/readings` (GET, POST → 202), `app/api/readings/[id]` (GET, DELETE) |
| UI | `components/readings/` — tray + seam (`readings-tray.tsx`, `api.ts`), reader (`reading-view.tsx`), offer card, passage action, node card section, library + page; chips/actions in `chat.tsx`, `plan-block.tsx`, `chain-table.tsx`, `graph-view.tsx`, `new-session.tsx`, `sidebar.tsx`, `activity-dock.tsx` |
| Data skill | `skills/learnharness/scripts/readings.py` (read-only); `sessions.py` treats `suggest_reading` as operational |
| Tests | `tests/readings.test.ts`, `tests/readings-ui.test.tsx`, `tests/skills/test_readings.py` |

Deviations from the proposal, kept deliberately small:

- **No per-role model override for the writer yet.** `writer` resolves from the strong slot (`ROLE_SLOT`) but is not in `BACKGROUND_MODEL_ROLES`, so the settings screen shows no separate row for it — adding it is a settings-UI change for the owner to rule on.
- **Reading prompts are not yet editable in settings.** They compose from source files like the other agents, but the prompt-override UI only lists teacher/prober/shared; adding a "Readings" section is the natural follow-up.
- **The writer holds one background permit for its whole run.** A researched reading is a long agent loop; it shares the 3-permit pool with extraction rather than getting a private lane (the semaphore's own ruling).
