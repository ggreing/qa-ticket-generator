# Improvement rounds (v3: QA case sheets from a spec)

Generated from `evals/rounds/v3/index.json` by the plan eval (`plan --round`, `--decision`). Do not edit by hand.
Scores are rubric v3 means on a 0–2 scale (docs/quality/RUBRIC.md). Must-cover, requirements with a case and
style violations are deterministic or checked against ground truth. A round is kept only if the overall rises
and none of those three gets worse. Rows are comparable only within one language. "(13/14)" after an overall
means the judge returned no usable score for the other sheets. The M3.5 rounds are in `ROUNDS.md`.

| Round | Date       | Prompt       | Change                                                                                   | Split    | Lang | Overall | Case | Sheet | Spec coverage | Must-cover | Req. with a case | Style viol./100 | Cases/spec | Merged away | Cost  | Decision |
| ----- | ---------- | ------------ | ---------------------------------------------------------------------------------------- | -------- | ---- | ------- | ---- | ----- | ------------- | ---------- | ---------------- | --------------- | ---------- | ----------- | ----- | -------- |
| 0     | 2026-11-13 | 2026-11-13.1 | baseline: plan prompt 2026-11-13.1                                                       | selected | ko   | 1.51    | 1.78 | 1.25  | 1.43          | 98%        | 100%             | 0.0             | 53.6       | 18          | $8.02 | keep     |
| 1     | 2026-11-13 | 2026-11-13.2 | prompt 2026-11-13.2: one intent one case, open outcomes as questions, merge with reasons | selected | ko   | 1.64    | 1.83 | 1.45  | 1.43          | 100%       | 100%             | 0.0             | 39.2       | 7           | $8.28 | keep     |
