# Capstone projects

A capstone is a build-it session. You pick a few propositions from your knowledge graph, pitch a project that puts them to use, and build it in your own editor. The capstone agent sharpens the pitch into a locked brief, then reads your project directory and reports what the finished work does and does not satisfy.

It sits beside teaching and practice rather than replacing them:

| Session | What it asks |
| --- | --- |
| Teaching | Can you follow the reasoning? |
| Practice | Can the knowledge come to mind unprompted? |
| **Capstone** | Can you turn what you know into something that exists? |

A capstone has no shell and never runs your code. Every verdict is a verdict from reading files, so runtime behaviour is judged from what the code does on its face — never from a test run.

## Starting one

You need at least one graph proposition to start. The picks are the material the project must use; without them the send control stays disabled.

- On the home screen, choose **Capstone** on the composer and pick propositions.
- Or use the sidebar's capstone button, or open `/chat/new?mode=capstone`.
- The sidebar can filter sessions to capstones and marks them with a hammer badge.

Inside the session the top bar shows a quiet **Capstone** chip instead of a teaching phase, and the composer is the ordinary one — no practice dock, no Next button.

## How a session runs

1. **Pitch.** You describe what you want to build and how it uses the picked material. The agent may ask questions that expose a vague pitch, but it does not design the project, choose the stack, or supply an architecture.
2. **Brief.** Once you accept the shaped brief and give the directory you will build in, the agent records it with the `brief` tool. That locks the title, directory and acceptance criteria for the session.
3. **Build.** You work outside Twig, in your own editor. The agent stays out of the way unless you ask for a review.
4. **Review.** A checkpoint at any time. The agent gives one verdict — `met`, `partial` or `unmet` — with file evidence for every criterion.
5. **Evaluate.** Your final submission. The agent reads the project again, gives evidence-backed verdicts, adds quality observations, and records a gap report. Resubmitting triggers a fresh evaluation; earlier evaluations stay in the transcript.
6. **Follow the gaps.** Gap areas tagged with proposition ids can start a teach or practice session seeded from exactly those propositions.

## The brief

A brief is the contract for the rest of the session:

```json
{
  "title": "Task tracker",
  "directory": "~/code/task-tracker",
  "criteria": [
    {
      "id": "persists",
      "text": "Tasks survive a restart because they are saved to a file",
      "targets": ["n_tasks"]
    },
    {
      "id": "rejects-bad-input",
      "text": "Malformed task input is rejected without crashing",
      "targets": []
    }
  ]
}
```

- The directory must exist. It can be absolute or start with `~/`.
- Criterion ids are permanent lowercase slugs: letters, digits, hyphens and underscores.
- A criterion is an observable property of the finished project, checkable by reading its code — not "has good structure" or "is well designed".
- `targets` are optional proposition ids from the session context. They connect a criterion to the material it exercises.
- There is one brief per session. A second `brief` call is refused; changing the criteria means starting a new capstone.
- Once the brief is accepted, the read-only file tools unlock in the same turn. The accepted brief is folded from the transcript, so it is not a separate field on the chat record.

## Review and evaluation

Both tools must cover **exactly** the brief's criteria, once each.

| Tool | When | What it records |
| --- | --- | --- |
| `review` | Any time you ask for a checkpoint | Verdicts plus a short summary; the session stays open |
| `evaluate` | When you submit the project | Verdicts, quality observations, and the gap report |
| `gap_report` | Only when no brief exists | Why the picked material is not yet usable for a build |

Verdicts are:

- `met` — the code read satisfies the criterion.
- `partial` — part of it holds; the verdict says which part.
- `unmet` — it is absent or wrong.

Every verdict cites file paths and line numbers. There is no overall score: the criterion verdicts and the gaps are the evaluation.

## The gap report

The gap report is the learning result, not a project score. It names areas that proved unready — concepts the code misused, avoided, or got wrong — and tags them with the picked propositions they correspond to.

An empty gap list is a real result when everything held. When gaps exist, the card offers **Teach these** and **Practice these**. Each opens a normal session titled `Revisit: <first four gap areas>` with the tagged propositions as graph context. If no gap carries a valid proposition id, the seeded session starts without picks.

If you cannot pitch anything that uses the material, the agent does not invent a project for you. It records a `gap_report` instead and points you back to teach or practice on those areas.

## What the agent can and cannot do

The capstone agent gets four project-scoped read-only file tools and four project tools:

| Tool | Purpose |
| --- | --- |
| `read`, `ls`, `find`, `grep` | Read the project directory only. Confined by realpath, so `..`, absolute paths and symlinks cannot escape. Refused until the brief exists. |
| `brief` | Record the accepted title, directory and criteria. |
| `review` | Checkpoint verdicts against every criterion. |
| `evaluate` | Final verdicts, observations and gaps. |
| `gap_report` | The no-pitch path, only before a brief. |

The prohibitions are part of the prompt doctrine:

- Never design any part of the project.
- Never give a hint, a fix, a debugging pointer, or a "how".
- Never record a brief the learner has not accepted, or without the directory.
- Never claim anything runs, passes, or works — the agent has only read it.
- Never give a verdict without evidence from a file.
- Never carry a verdict forward from an earlier evaluation without re-reading.

## What it does not touch

Capstone sessions do not write to the knowledge graph and do not extract nodes or chains. They are also kept out of readings, review evidence, chain sources and graph extraction. Like practice, the session is evidence about learning, not a mutation of the world model.

## Implementation map

| Area | Starting point |
| --- | --- |
| Chat kind and brief fold | `src/core/contracts/chat.ts`, `capstoneBriefOf` in `src/core/native-messages.ts` |
| Agent tools | `src/agent/tools/capstone.ts` |
| Scoped file tools | `src/agent/tools/scoped-fs.ts` |
| Prompt | `src/agent/prompts/capstone/00-base.md`, `10-doctrine.md` |
| UI cards and parsing | `components/capstone-cards.tsx`, `src/core/capstone-parts.ts` |
| Tests | `tests/capstone-agents.test.ts`, `tests/capstone-ui.test.tsx` |

The runtime architecture reference has a shorter section on the same session kind: [`architecture.md` §4a](architecture.md#4a-capstone-sessions).

## Provenance

The feature was adapted from Mayank Madan's LearnHarness fork:

- Source: [`mayankmadan/learnharness@01cb3c6f`](https://github.com/mayankmadan/learnharness/commit/01cb3c6fc746555e653f8b0d61fd6a5cd121e29f) — "feat: capstone project mode" (2026-11-06).
- Twig adaptation: `09d87dc` — "feat(capstone): add capstone project sessions".
- Merged into Twig `main`: `0f79109`.
