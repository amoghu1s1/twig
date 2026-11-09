# Style rubric: learner-facing prose

This rubric measures whether learner-facing prose has the explanatory quality of a
well-edited textbook section. It is not a test for "human" writing and it does not
penalize AI features.

The target is clear, complete explanation. Headings, bullet lists, bold key terms,
equations, code blocks, em-dashes for definitions, and a simple metaphor are all
fine when they help the learner follow the material. The prose may be unmistakably
AI-generated and still be good.

## What the target looks like

A good explanation often starts by defining the thing plainly, then gives the core
idea, the formal statement, the terms the learner needs, the intuition, and the
variants or caveats. That is a description of a useful shape, not a template the
model must fill in. The model should use the shape when it fits and drop it when it
does not.

A useful reference is a well-edited textbook section or a good explanatory article:
the first paragraph says what the thing is, the middle explains how it works, and
the end says what changes in practice. The learner can follow the reasoning without
having to reconstruct missing steps.

## The specific tics to avoid

The problem is not structure, formatting, or the fact that the text is AI-generated.
The problem is a rhetorical register that performs insight instead of explaining.

The clearest example is this kind of answer:

> And your question — any way to avoid that? — has exactly one answer, and it's the
> entire point of the standard method: compute every slope analytically instead of
> measuring it. No nudging, no re-runs, no limits. Just the chain rule you already
> have, organized into a single sweep.

It fails because it does four things at once: it asks a rhetorical question and
answers it, it comments on the question and the method instead of answering, it uses
a three-part negation as a flourish, and it compresses the answer into an aphorism.
The learner wanted the answer, not a performance about the answer.

The same content can be written directly:

> Yes. Compute each slope analytically instead of measuring it. The chain rule gives
> you every derivative in one pass, so you do not need to nudge the input or re-run
> the measurement.

The second version is still a little AI-ish. It is also clear, complete, and useful.
That is the goal.

## Checklist

Score each output 0 or 1 per item. Items 5 through 9 are hard requirements. The rest
are quality signals.

1. The first paragraph defines the thing or answers the question.
2. The explanation is complete enough to follow without guessing missing steps.
3. Structure, formatting, equations, and diagrams are used where they help.
4. Any metaphor maps cleanly onto the mechanism and does not mislead.
5. There is no rhetorical question that the model answers itself.
6. There is no commentary about the question, the method, the prompt, or the harness.
7. There is no three-part negation used as a rhetorical flourish.
8. There are no aphoristic phrases such as "the entire point" or "exactly one
   answer" used in place of an explanation, and no closing sentence that
   summarizes what the explanation just did or says what the result "came
   from."
9. No abstraction is used as an agent in a way that hides who does what. "The
   material decides," "the hour uses," "the limit removes the corner," "the
   derivation is forced," "three facts sit at the bottom," "the route will
   stay," and "the faces hand you the answer" are examples.
10. The length matches the difficulty of the material.
11. The prose does not repeat the same idea in different words.
12. The learner can see why each step follows from the previous one.

Scoring:

- 12/12: target.
- 10 or 11: minor issues. Review the failed items.
- 9 or fewer: rewrite the output or the prompt that produced it.

For a prompt comparison, run six prompts, five samples each, on each model. Record
the hard-pass rate for items 5 through 9. A prompt change is an improvement only if
the hard-pass rate rises without losing teaching quality.

## Test prompts

Use these in a fresh session for each sample. Do not reuse a session between prompts
or between runs.

1. "Is there any way to avoid measuring the slope? I keep getting it wrong."
2. "I don't understand why the chain rule works here. Can you explain it?"
3. "I predicted that the belief would go down after a correct answer, but the answer
   says it goes up. Why?"
4. "What should I learn next?"
5. "Can you give me a hint on this problem?"
6. "This passage says the update is closed-form. What does that mean?"
7. "Rewrite this sentence in clear subject-verb-object English: 'This data is all this hour uses.'"

The expected answer to the seventh prompt is close to: "This is all the data used
this hour." It is a calibration check for the sentence-level clarity rule. The model
should include "that", "which", or "who" when the relation would otherwise be
ambiguous, and it should ask rather than guess when a phrase has two readings.

Fresh sessions matter. The transcript is an in-context style example. A prompt change
does not rewrite the teacher turns already in the chat.

## Running the checker

The checker is a heuristic. It finds the mechanical tics, not teaching quality. Use
the checklist for the final judgment.

```bash
node scripts/style-check.mjs output.md
node scripts/style-check.mjs --strict output.md
cat output.md | node scripts/style-check.mjs
```

The script strips fenced code blocks and inline code before counting. It prints
sentence statistics, hard failures, warnings, and neutral counts for em-dashes and
question marks. `--strict` exits with status 1 when a hard failure is present.

## Comparing models

Run the same six prompts on each model you are comparing, five samples each, in
fresh sessions. Save the outputs under a scratch directory, then run the checker on
each file.

Record:

- hard-pass rate for items 5 through 9,
- a blind human rating of teaching quality from 1 to 5,
- whether the output used structure and formatting to help the explanation,
- whether any metaphor or equation made the explanation clearer.

Do not compare a single sample. Style is stochastic, and one output can look better
or worse by chance.

## What the checker cannot see

The checker does not know whether an explanation is correct, whether the step is the
right size, or whether the check is well designed. It only measures the surface
tics. A clean report is necessary, not sufficient.
