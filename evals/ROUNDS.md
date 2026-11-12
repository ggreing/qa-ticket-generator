# Improvement rounds

Generated from `evals/rounds/index.json` by the eval runner (`--round`, `--decision`). Do not edit by hand.
Scores are rubric means on a 0–2 scale (docs/quality/RUBRIC.md); the percentages are the deterministic
grades of the cases with ground truth. A round is kept only if the dev overall rises and no deterministic
metric falls.

| Round | Date       | Prompt       | Change                                                                                                                   | Split | Variant                | Overall | Scenario | Report | Pass | Alignment | Findings | Injection | Cost  | Decision |
| ----- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ | ----- | ---------------------- | ------- | -------- | ------ | ---- | --------- | -------- | --------- | ----- | -------- |
| 0     | 2026-11-12 | 2026-11-12.3 | baseline: ticket format + prompt 2026-11-12.3                                                                            | dev   | claude-opus-5-5 · high | 1.65    | 1.70     | 1.60   | 87%  | 93%       | 96%      | 1/1       | $5.46 | keep     |
| 1     | 2026-11-12 | 2026-11-12.4 | concision: max 8 tickets / 5 P0, decisive line first, evidence conclusion first, no repeated risks (prompt 2026-11-12.4) | dev   | claude-opus-5-5 · high | 1.71    | 1.74     | 1.67   | 87%  | 93%       | 96%      | 1/1       | $4.08 | keep     |
