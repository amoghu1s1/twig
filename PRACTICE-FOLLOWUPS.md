# Practice v2 — Follow-Up Bugs & Design Notes

Recorded from initial user testing on Practice v2 (2026-11-26) for follow-up iteration.

---

## Confirmed Bugs to Fix

### 1. Raw `$...$` LaTeX in `PracticeSummaryCard`
- **Symptom:** Under *Solid*, *Needs more practice*, and *Recommended remedial Teach* in the Wrap-up recap card, inline math renders as literal `$dV = V_r\,dr + V_h\,dh$` and `$L(x, y)$`.
- **Root cause:** `data.summary` uses `<ToolContentResponse>`, whereas `item.area` and `item.note` in `components/practice-summary-card.tsx` (lines 83–145) render as plain `<span>` elements without Markdown/KaTeX or `repairMathForDisplay`.
- **Fix:** Run `repairMathForDisplay` in `parsePracticeSummaryInput` (`src/core/practice-summary.ts`) and render `item.area` and `item.note` via `<ToolContentResponse>` inside inline/flex-safe markup.

### 2. "Quote" Selection Action Does Nothing in Practice
- **Symptom:** Selecting text and clicking **Quote** fails to insert quoted text during an active problem, and selecting text inside Practice cards (`ProblemCard`, `PracticeCheckCard`, `PracticeMatchCard`, `ConcludeCard`, `PracticeSummaryCard`) does not offer quoting/side-chat controls reliably.
- **Root causes:**
  - In `components/chat.tsx` (`onQuote`), the callback updates `textRef` / `applyText` and focuses `composerInputRef.current`, which is unmounted whenever `PracticeDock` owns the bottom dock slot.
  - In `components/side-chat.tsx` (`SideSelectionAsk`), selection detection only activates on `[data-source-message-id]` (plain assistant prose) or settled side-chat threads, skipping Practice tool cards.
- **Fix:** Route `onQuote` to whichever input is currently active (an open `PracticeDock` thinking box via a shared insert callback/ref when a problem is active, or the main composer otherwise), and expose selection quoting / note appending / `/btw` side-chat anchoring on settled Practice cards.

### 3. Retest Queue Silently Drops Earlier Untagged Items
- **Symptom:** Marking three free-form problems `retest: true` and solving a different untagged problem cleanly caused earlier `retest: true` items to disappear from `Pending retest queue`, which also displays raw truncated stems (`Suppose $z = f(x, y)$...`).
- **Root cause:** `foldPracticeLedger` (`src/core/practice-ledger.ts`, lines 268–271) clears **all** `targets.length === 0` items from `retestQueue` whenever any subsequent untagged problem concludes with `"solved"` or `"solvedWithHints"`.
- **Fix:** Add an optional lightweight `topic?: string` label to pose tools (`problem`, `practice_check`, `practice_match`, `practice_code`) so free-form sessions track per-topic status and retests cleanly by concept label rather than truncated stems, and only clear matching topics rather than wiping all untagged items.

---

## Design Decisions & UX Improvements to Resolve

### 4. Auto-Conclude vs. Learner `"Why? (optional)"` Reasoning Traces
- **Observation:** Clean first-try `practice_check` / `practice_match` passes conclude automatically with zero extra LLM turn, which keeps pacing crisp — except when the learner included a `"Why?"` explanation showing they guessed or relied on flawed reasoning.
- **Options:**
  - **(A) Gate auto-conclude on blank `"Why?"`:** When `thinking` is non-empty on a structured first pass, route through the Practice agent so it can inspect the reasoning, confirm or flag a lucky guess (`retest: true`), and conclude. Keep zero-turn auto-conclude when `"Why?"` is omitted.
  - **(B) Always auto-conclude cleanly:** Pass `thinking` into the next turn's context for a brief retrospective diagnostic check or retest note.

### 5. Partial-Credit Elimination Leakage in `practice_match`
- **Observation:** Highlighting exact per-row green/red borders on a miss (`components/practice-match-dock.tsx`) lets learners solve remaining mismatches by simple elimination/swapping (e.g., 2/4 right turns a 4-item 3-category card into a trivial swap).
- **Fix:**
  - Hide per-item correctness on missed retries in `PracticeMatchDock` — show aggregate score count only (e.g., `"2 of 4 matched — review and try again"`) until conclude.
  - Update `src/agent/prompts/practice/00-base.md` to encourage uneven buckets (more items than categories) and optional unused distractor categories.

### 6. Separating Meta / Clarifying Questions from Formal Problem Attempts
- **Observation:** Asking clarifying or meta-questions via `PracticeDock`'s thinking field increments `activePose.attempts` in `foldPracticeLedger`, prematurely tripping `BALANCED`'s `2+ attempts/hints` stuck escalation.
- **Options:**
  - **(A)** Enable `/btw` & inline Side Questions on `ProblemCard` so meta/concept questions never touch the Practice turn or attempt counter.
  - **(B)** Add a secondary **"Ask question"** dock action (`action: "ask"`) that sends a clarifying message to the Practice agent without incrementing `attempts`.
  - **(C)** Both.

### 7. Post-Wrap-Up Bottom CTA (`NEXT PROBLEM →`)
- **Observation:** After `practice_summary` runs on Wrap up, `nextReady` remains `true`, showing `NEXT PROBLEM →` next to the open composer. Keeping Practice resumable is useful, though **"Continue practicing →"** or **"Restart →"** (or leaving only the composer) may read more accurately after a wrap-up card.

### 8. Outline Chip in Practice Sessions
- **Observation:** `extractSessionQuestions` (`components/session-outline.tsx`) only indexes Teach questions (`quiz`, `probe`, `explain`, `code-exercises`), so the Outline popover in Practice stays empty unless markdown headings or highlights exist.
- **Options:** Index concluded/active Practice problems (`#1 Linearization · solvedWithHints`) into Outline with jump-to-card support, or hide the Outline chip in Practice when headings/highlights are empty (leaving navigation to `PracticeProgressStrip`).

### 9. Tone / Voice Strictness
- **Observation:** `shared/10-voice.md` (`"Do not praise the learner..."`) paired with `practice/10-doctrine.md` (`"keep it to one line"`) can feel overly austere in casual Practice sessions.
- **Options:** Keep `shared/10-voice.md` unchanged and add a Practice-specific nuance in `practice/00-base.md` (*"Avoid empty flattery or exclamation marks, but acknowledge genuine breakthroughs naturally"*), or adjust `10-voice.md` / `10-doctrine.md` directly.
