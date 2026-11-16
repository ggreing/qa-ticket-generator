# Improvement rounds (v3: QA case sheets from a spec)

Generated from `evals/rounds/v3/index.json` by the plan eval (`plan --round`, `--decision`). Do not edit by hand.
Scores are rubric v3 means on a 0–2 scale (docs/quality/RUBRIC.md). Must-cover, 2nd-order recall, requirements
with a case and style violations are deterministic or checked against ground truth. A round is kept only if the
overall rises and none of those four gets worse. 2nd-order recall is the share of a fixed list of combinations
(expected.secondOrder) that have a case; it is the figure coverage is compared by, since the judge-scored "Spec
coverage" reads about the same whatever the sheet. Rows are comparable only within one language. "(13/14)" after
an overall means the judge returned no usable score for the other sheets. The M3.5 rounds are in `ROUNDS.md`.

| Round | Date       | Prompt       | Change                                                                                                                                                               | Split    | Lang | Overall | Case | Sheet | Spec coverage | Must-cover | 2nd-order recall | Req. with a case | Style viol./100 | Cases/spec | Merged away | Cost  | Decision |
| ----- | ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- | ------- | ---- | ----- | ------------- | ---------- | ---------------- | ---------------- | --------------- | ---------- | ----------- | ----- | -------- |
| 0     | 2026-11-13 | 2026-11-13.1 | baseline: plan prompt 2026-11-13.1                                                                                                                                   | selected | ko   | 1.70    | 1.81 | 1.60  | 2.00          | 98%        | 86%              | 100%             | 0.0             | 53.6       | 18          | $8.16 | keep     |
| 1     | 2026-11-13 | 2026-11-13.2 | prompt 2026-11-13.2: one intent one case, open outcomes as questions, merge with reasons                                                                             | selected | ko   | 1.82    | 1.86 | 1.79  | 2.00          | 100%       | 82%              | 100%             | 0.0             | 39.2       | 7           | $8.41 | keep     |
| 2     | 2026-11-16 | 2026-11-16.1 | prompt 2026-11-16.1: seven questions a requirement does not ask for (who else, zero/same, per what, across the line, and then, other thing's state, what comes back) | selected | ko   | 1.75    | 1.83 | 1.67  | 1.93          | 100%       | 91%              | 100%             | 0.0             | 42.8       | 5           | $9.37 | revert   |
| 3     | 2026-11-16 | 2026-11-16.3 | prompt 2026-11-16.3: seven questions once per action/value/period, merge pass for every sheet                                                                        | selected | ko   | 1.81    | 1.86 | 1.76  | 2.00          | 98%        | 93%              | 100%             | 0.2             | 37.9       | 7           | $8.82 | revert   |
