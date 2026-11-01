# Plan: review feature
> Status: phase 1 (minimal version, sections 1–9) and phase 2 (noise-reduction rules, sections 10–16) are implemented and verified. Phase 3 (evidence quality and workload, sections 17–21) is implemented in the Twig fork.
> 
> Terminology: this document uses "node" throughout for a proposition in the graph, matching the UI wording; code identifiers (such as `proposition`, `graphContext.propositions`) stay as they are.

Investigation basis: `src/agent/tools/practice.ts`, `src/core/native-messages.ts` (`problemInputForConclude`), `src/core/question-core.ts`, `app/api/chats/route.ts`, `components/new-session.tsx`, `src/store/graph.ts`, `src/core/ports.ts`, `docs/architecture.md` §7, `docs/vision.md`.

* * *
# Phase 1: minimal version
Scope: review records, the due list, and starting a practice session with due nodes. Excludes FIRe, the five-state state machine, 70/30 mixing, speed gating and CAT diagnosis (see section 7).
## 1. Goal
Each time the learner completes a practice problem that carries a `target`, the system records when that node was retrieved and how it performed. It then offers a "due review" list; selecting due nodes starts a practice session.
## 2. Current state: where review signals come from
| Source | Node-level signal? | Notes |
|---|---|---|
| `problem` and `conclude` in a practice session | Yes | `problem.target` is a graph node ID (validated on write; names are normalized to IDs); `conclude` carries `outcome`, `rung` (R0–R5 or null), `missClass`, `retest` |
| quiz in a teaching session | No | a quiz's `nodeId` is a node in the session's plan tree, not a graph node ID |
| practice on a free topic (no `target`) | No | the problem is not tagged with a node |

Review signals therefore come only from practice problems that carry a `target`. Only nodes that have appeared in practice enter review.

The local `data/` has no practice sessions (0 practice out of 143 chats, 0 graph nodes), so the signal volume cannot be estimated from real data; the conclusions above come from the code.
## 3. Design constraints
1. `docs/architecture.md` §7 states `spaced repetition…stays parked` and specifies that grading writes nothing to the graph. This is the upstream author's ruling. This fork deliberately overturns the part about review, but keeps the principle: review state is not written into nodes, and the graph remains a pure world model.
  
2. `docs/vision.md` specifies that understanding is only inferred, never encoded, that derived state is not stored, and that the event log is the source of truth. Review state is therefore derived from events rather than stored as a number that goes stale.
  
3. Layering rule: `src/core` is pure functions and must not import `agent`, `server` or `store`. The scheduling algorithm lives in core.
  
## 4. Design
### 4.1 Data source (Q1, settled: option A)
- **Option A (adopted): derive from chat records, add no storage.** Scan every chat with `kind === "practice"`; for each clean `conclude`, use `problemInputForConclude` to obtain the paired `problem.target`, yielding an event `{nodeId, at, outcome, rung, missClass}`.
  
  - Pros: no new storage, no format change; covers all existing practice history automatically; consistent with "derive, do not store"; no possibility of the ledger disagreeing with the chats.
    
  - Cons: every read scans chats (fine at the scale of 143 files; add a cache at thousands); deleting a chat also deletes its review records.
    
- **Option B (not adopted): a new append-only ledger** `data/graph/reviews.jsonl`, with one line written at `conclude` time.
  
  - Pros: deleting a chat does not lose history; reads are fast.
    
  - Cons: requires a new `LEDGER_FILES` entry, store, port and format version stamp; existing practice is not backfilled automatically; the write point must be wired into the turn flow.
    
### 4.2 outcome to rating (Q2 settled)
FSRS ratings are Again, Hard, Good and Easy. The mapping looks only at `outcome` and `rung`:

| conclude | FSRS rating |
| --- | --- |
| `solved` with rung null, R0 or R1 | Good (Easy is never used) |
| `solved` with rung ≥ R2, or `solvedWithHints` | Hard |
| `surrendered` | Again |
| `movedOn` | produces no event |
| `dismissed` | produces no event (synthesized by the system; no retrieval evidence) |
### 4.3 Scheduling (settled: `ts-fsrs`, FSRS-6, default weights)
- Depends on `ts-fsrs`. It is a pure-function library, so placing it in `src/core` does not violate the layering lint (the lint only forbids core from importing agent, server or store).
  
- Each node's state comes from replay: for events sorted by time, call FSRS one by one starting from an empty card and fold into `{ due, stability, difficulty, state, lapses, lastReview }`. Pure function, with `now` passed in as an argument.
  
- The target retention `request_retention` is 0.9, defined in a single constant in core.
  
- Anki-style minute-level learning steps are disabled (`learning_steps` and `relearning_steps` are empty); otherwise a first correct answer would be due again 10 minutes later. Fuzz is disabled so results are deterministic.
  
- Multiple reviews on the same day are handled by FSRS-6's short-term weights; no hand-written deduplication.
  
- Nodes deleted from the graph are dropped silently, without error.
  
- Ordering: earlier due time (longer overdue) comes first; no weights and no mastery score.
  
- The default weights were trained on Anki flashcard data; this project's events are open-ended reasoning problems graded by an LLM, which are noisier, and there is not enough data to train personal weights. Interval days are only a reference.
  
- Test coverage: out-of-order events, same-day repeats, deleted nodes, missing `target`, and `dismissed`/`movedOn` being ignored.
  
### 4.4 UI and starting a review
- Backend: `GET /api/review` returns `{ due: [...], upcoming: [...], now, sessionSize }`, composed of core's derivation function plus the server's chat reads. Read-only; it triggers no writes.
  
- Entry point (Q5 settled): a new Review row in the sidebar showing the due count; opening it shows the due list, with the 8 most overdue selected by default, and clicking Start review starts the session.
  
- Starting: reuse `startDraftSession(draft, fetch, "practice", picks)`, passing the selected nodes as `graphContext.propositions`. The session title and first message are `Review: node name list`. No new problem type is added and the practice prompt is unchanged; `conclude` naturally becomes the next review event.
  
- Node cap (Q6 settled): `app/api/chats/route.ts` applies `.slice(0, 64)` to picks; the UI defaults to 8, adjustable by hand, up to 64.
  
## 5. File change list
| Location | Change |
|---|---|
| `package.json` | add dependency `ts-fsrs` |
| `src/core/review-events.ts` (new) | extract events from `LhMessage[]`, reusing `problemInputForConclude` |
| `src/core/review.ts` (new) | rating mapping, replay with ts-fsrs, due filtering and ordering, payload derivation |
| `src/core/review-payload.ts` (new) | payload types and constants usable in the browser |
| `src/core/index.ts` | export payload and event types |
| `src/server/review.ts` (new), `app/api/review/route.ts` (new) | read all practice chats, call core, serve `GET` |
| `components/review-*.tsx`, `components/sidebar.tsx`, `app/review/page.tsx` | list page and sidebar entry |
| `docs/architecture.md` §7 | state that review state is derived from practice events and not written to the graph |
| `tests/review*.test.ts*`, `tests/render-review.test.tsx` | table-driven tests |
## 6. Verification
- All core tests are deterministic unit tests: no network, no real clock.
  
- Run `npx tsc --noEmit`, `npm test`, `npm run lint` (lint enforces layering).
  
- Walk through the real app: create a practice session, check the due list, start a review session, answer, and confirm the rating is written back.
  
## 7. Out of scope for this phase
- FIRe implicit review (adding weak evidence to upstream nodes along the chain, merged problem selection).
  
- The five-state state machine, 70/30 mixing and speed gating (only meaningful for code problems; reassess once code-problem support is done).
  
- CAT diagnosis: this graph contains only learned material, with no "not yet learned upstream", so the value is limited.
  
- Teaching-session quizzes entering review: this requires aligning quizzes with graph nodes first and is a separate problem.
  
- Flashcards: `docs/code-practice-plan.md` already records this as a separate plan.
  
## 8. Phase 1 decisions
| Question | Decision |
| --- | --- |
| Scope | review records, the due list, starting practice sessions with due nodes |
| Q1 data source | option A: derive from chat records, add no storage |
| Scheduling algorithm | `ts-fsrs` (FSRS-6, default weights, 0.9 target retention); hand-written coefficients and same-day deduplication are no longer needed |
| Q2 `movedOn` | produces no event |
| Q-Easy | Easy is not used: `solved` with no hints or with only R0–R1 counts as Good |
| Q5 entry point | a standalone Review page in the sidebar |
| Q6 node cap | default 8, adjustable by hand on the page |
| Q7 architecture doc | add a note in `docs/architecture.md` §7 that explicitly overturns `parked` |
| Session text | title and first message are `Review: node name list` |
## 9. Phase 1 implementation order (done)
1. `src/core/review-events.ts` and tests.
  
2. `src/core/review.ts` and tests, add the `ts-fsrs` dependency.
  
3. `src/server/review.ts`, `GET /api/review` and tests.
  
4. Review page, sidebar entry, render tests, wire up `startDraftSession`.
  
5. `docs/architecture.md` §7 note; run `tsc`, `lint`, `test` and verify in the real app.
  

* * *
# Phase 2: noise-reduction rules
This phase changes only how evidence turns into a rating; it does not change FSRS itself.
## 10. Background: noise sources and what comparable products do
Events are open-ended reasoning problems graded by an LLM, and the default weights were trained on flashcard data. Two comparable products:

| Product | How it handles noise | Adopted? |
| --- | --- | --- |
| Execute Program (Python course) | avoids grading noise at the source: review items are small code examples, graded by running the code; a wrong answer halves the rung instead of resetting it | Not adopted. It relies on deterministic grading of code problems, which is separate work |
| Nodeledge | does not act on a single bad result; verifies before intervening; reviewing a high-level node also reinforces its upstream nodes | Adopts the "verify before intervening" idea (R2); upstream reinforcement is FIRe in section 7 |

Sources: Execute Program's "halve the rung" comes from a search-result summary of its Spaced Repetition page; the page itself could not be read. Nodeledge's behavior comes from the high-level description on its how-it-works page; the page does not publish formulas or parameters.
## 11. Two problems with the current rules
Measured with default `ts-fsrs` parameters. Assume the node is already stable: one correct answer (Good) each on days 0, 2 and 13, giving stability S of 46 days.

| Case | Resulting S | Next due |
| --- | --- | --- |
| One Again on day 30 | 2.69 | 3 days later |
| Again on day 30, retested Good the same day | 2.69 | 4 days later |
| Again on day 30, Good on day 32 | 6.25 | 6 days later |

1. **A single failure makes stability collapse.** A node with 46 days of stability drops to 2.7 days after one Again. If that failure came from carelessness, an execution slip or an overly strict LLM grade, the loss is too large.
  
2. **An in-session retest does almost nothing for scheduling.** The practice prompt asks for a retest after failure, but the retest happens after the answer is revealed, and FSRS-6's same-day formula adds essentially no stability for it.
  
## 12. Rule R1: only memory failures count as failures (Q8 settled)
`conclude` already records `missClass`; the current rating does not use it.

| missClass | Meaning | Rating treatment |
| --- | --- | --- |
| `cue` | could not recall at all | memory failure, per the rules in 4.2 |
| `discrimination` | chose the wrong candidate proposition | memory failure, per the rules in 4.2 |
| `structural` | the proposition extracted was itself wrong (misunderstanding) | memory failure, per the rules in 4.2 |
| `execution` | proposition correct, error in execution | not forgetting; rated Good |
| `careless` | careless | not forgetting; rated Good |
| null | no mistake | per the rules in 4.2 |

Additional notes:

- Applies only to `solved` and `solvedWithHints`, and no longer downgrades to Hard for rung ≥ R2, because the reason a hint was needed is execution, not failure to recall.
  
- `surrendered` is always Again.
  

Decision: both `execution` and `careless` are rated Good.
## 13. Rule R2: the first failure of a stable node is only provisional (Q9, Q10, Q11 settled)
Corresponds to Nodeledge's "verify before intervening".

**Scope (Q10 settled):** only stable nodes, that is, current stability ≥ 7 days. A new node's Again is handled as usual, since there is little stability to lose.

Not using "at least 2 successful reviews" as the criterion, because FSRS's `reps` also counts multiple reviews on the same day. Measured: three correct answers in a row on the same day give `reps` of 3 while stability is still 2.31; one more correct answer 2 days later raises stability to only 10.96. Requiring stability ≥ 7 days demands a correct answer after a real gap.

**Flow** (each node replayed in time order):

1. A stable node gets an Again: do not update FSRS state, mark it as a "provisional failure", and set the due time to 1 day later.
  
2. (Q11 settled) Within the same session, ignore all events after a provisional failure. These events happen after the answer is revealed and cannot evidence long-term memory.
  
3. In a later session, review again:
  
  - fails again: confirm the failure and update as Again.
    
  - succeeds (Q9 settled): rate at most Hard.
    

**Measured comparison** (S = 46 days, first failure on day 30):

| Later result | Current rules | R2 |
| --- | --- | --- |
| Good on day 32 | S = 6.25, due 6 days later | rated Hard: S ≈ 81, due 81 days later |
| Again on day 32 | S = 0.61, due 1 day later | S = 2.71, due 3 days later |

If the success after a provisional failure were still rated Good, stability would be 104.62, due about 105 days later; capped at Hard it is 81 days.

**Trade-off:** R2 punishes an accidental failure far less (81 days versus 6 days), avoiding a large stability downgrade from one noisy result. The cost: if the failure reflects real forgetting and the next attempt happens to succeed, the system overestimates mastery. Accepted, because it verifies again 1 day later and caps the success rating at Hard rather than Good.
## 14. State machine
Each node's replay state gains a provisional-failure flag `pending` (recording the failure time and the session it belongs to):

```
For each event e (sorted by time), grade = rating mapping (including R1):

If pending exists:
    If e belongs to the same session as pending: ignore e
    Otherwise:
        If grade is Again: update as Again, clear pending
        Otherwise: update as min(grade, Hard), clear pending
Otherwise:
    If grade is Again and node stability ≥ 7 days:
        set pending = (time of e, session of e), FSRS state unchanged
    Otherwise:
        update as grade

Output dueAt:
    pending exists → time of pending + 1 day
    otherwise → FSRS's due
```
## 15. File change list
| Location | Change |
|---|---|
| `src/core/review-events.ts` | `ReviewEvent` gains `missClass` and `session` (chat ID); `reviewEventsFromMessages(messages, session)` |
| `src/server`, `reviewPayload` in `src/core/review.ts` | pass each chat's ID into event extraction |
| `src/core/review.ts` | `gradeOf` implements R1; `foldReviews` replay becomes the state machine with `pending` (section 14); `NodeReview` gains `verifying: boolean` |
| `src/core/review-payload.ts`, `components/review-view.tsx` | `ReviewItem` gains `verifying`; due rows are marked "awaiting re-confirmation" when `verifying` |
| `tests/review*.test.ts*` | R1 covers every `missClass`; R2 covers first failure, later events in the same session being ignored, a later success capped at Hard, a later failure being confirmed, new nodes (stability < 7 days) unaffected, the boundary where stability is exactly 7 days, and same-day repeated reviews not making a node "stable" |
| `docs/architecture.md` §7 | add rating rules R1 and R2 |
## 16. Phase 2 decisions
| Question | Decision |
| --- | --- |
| Q8 `execution` and `careless` | both rated Good, and not downgraded to Hard for rung ≥ R2 |
| Q9 success after a provisional failure | rated at most Hard |
| Q10 criterion for "stable" | stability ≥ 7 days (not reps ≥ 2) |
| Q11 events after a provisional failure in the same session | always ignored |

* * *

# Phase 3: evidence quality and workload (Twig fork)
Status: implemented. Every rule below still derives from chat records; there is no new store, no write-back to the graph, and no cache.

## 17. Evidence-quality fixes
### 17.1 Multi-target failures are capped at Hard
`problem.target` may name several propositions. A joint failure is ambiguous about any single proposition in the set, so applying `Again` to every target over-penalizes all of them. `ReviewEvent` now carries `targetCount`, and `gradeOf` maps a `surrendered` outcome on a multi-target problem to **Hard** instead of **Again**. Successful outcomes are unchanged: solving a joint problem is positive evidence for every constituent. `src/core/review-events.ts`, `src/core/review.ts`.

### 17.2 A retest is the session's evidence
`conclude.retest` marks the problem for a fresh-surface retest before the session ends. The retest is the confirming observation, so a retest-marked event now defers to the next event for the same node in the same session; if no same-session successor exists, the marked event still counts. The R2 provisional-failure state machine runs on the remaining events, unchanged. `src/core/review-events.ts`, `src/core/review.ts`.

### 17.3 Event time is the conclude result's time
`ReviewEvent.at` was the assistant message's timestamp (when the generation started). It now comes from the matching `toolResult` message's timestamp — the moment the conclude executed — falling back to the assistant timestamp when no result exists. This keeps same-turn ordering stable and makes the event clock (and the row's last-attempt age) honest. `src/core/review-events.ts`.

## 18. Leech signal
A node whose FSRS lapse count reaches `LEECH_LAPSES` (3) is marked `leech` in the payload and shown as **re-learn** on its review row. This is a signal, not a new schedule: intervals still come from FSRS. It tells the learner that more retrieval practice on this node is not the fix — the teaching or the chain behind it is. `src/core/review.ts`, `src/core/review-payload.ts`, `components/review-view.tsx`.

## 19. Why this is due
Each review item now carries the last outcome, the last **attempt** time, stability and the lapse count. The row renders a compact second line (`last solved · 12d ago · S 46d · 3 lapses`), so the schedule is legible instead of magical. A provisional failure counts as the last attempt even though it leaves the FSRS card untouched. All of it is folded from the same events; nothing new is stored. `src/core/review.ts`, `src/core/review-payload.ts`, `components/review-view.tsx`.

## 20. Workload: forecast and daily target
`GET /api/review` now returns a seven-day forecast (today plus six days, day granularity; overdue folds into today) and `REVIEW_DAILY_LIMIT = 20`. The Review page shows the forecast as a compact strip and states how many due items sit beyond today's target. The limit **informs** the selection; it never hides a due item, because review state is derived and nothing should silently disappear. `src/core/review-payload.ts`, `src/core/review.ts`, `components/review-view.tsx`.

## 21. Verification
Table-driven tests cover each rule: `gradeOf` multi-target vs single-target surrender, retest deferral with and without a same-session successor, the `toolResult` timestamp and its fallback, the leech threshold and boundary, last-outcome projection, forecast bucketing (overdue, today, day boundaries), and the daily-limit projection. Gates: `npx tsc --noEmit`, `npm run lint`, `npm test`.
