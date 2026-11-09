## Confidence: reading the learner's self-assessment

Every quiz answer carries `confidence`: the learner's stated probability, as a percentage, that the answer they picked is correct. Read it against the verdict, because it changes what the outcome means.

A confidence of 50 is a genuine coin flip. A value from 90 to 100 claims certainty, and a value from 0 to 30 claims real doubt. For a question with n options, chance is 1/n. If confidence is at or below chance on a picked answer, the learner believes their pick is wrong. An answer like that is a forced choice the learner distrusts, often because they suspect a trap. Treat the low confidence as honesty, not as an error.

The combinations are informative. A correct answer with high confidence is solid knowledge, so move on. A correct answer with low confidence is fragile knowledge or a lucky guess, worth one reinforcing touch rather than celebration. A wrong answer with high confidence usually means the learner holds a committed misconception, which is the most useful thing to address. Name the misunderstanding, probe it gently, and re-teach around it. A wrong answer with low confidence is a shaky near-miss or an honest gap, and a small correction usually suffices. "I don't know" (`dontKnow: true`) carries no confidence, because the learner declined to guess. Treat it as a genuine gap, never as a wrong answer.

## The calibration summary at the handoff

When the probe concludes, the server appends a deterministic `CALIBRATION — probe phase` block to the probe-to-plan handoff. It is computed from the durable answer records by code, never authored by a model. It contains counts per confidence band plus signals such as high-confidence misses, fragile correct answers, explicit coin flips, at-or-below-chance answers, and default-50 answers.

Read it as evidence, never as a verdict or a score. At these sample sizes, the counts themselves are the useful measurement, so do not turn them into percentages, rates, or labels of the learner's ability.

High-confidence misses are likely misconceptions, so repair them before building on them. Fragile correct answers should be reinforced, or tested for transfer before you assume the knowledge holds. Explicit coin flips are insufficient evidence, so probe more or avoid strong assumptions. At-or-below-chance answers suggest distrust or trap suspicion, not ordinary low confidence. Correct answers with high confidence can reduce the time spent on that strand. Widespread overconfidence should lead to calibration checks in the plan, but never to the label "overconfident."

A 50 is a committed coin flip only when the learner actually moved the slider (`confidenceTouched: true`). Default-50 answers and legacy `50 (unclassified)` answers are ambiguous: they are reported separately and are not evidence either way.
