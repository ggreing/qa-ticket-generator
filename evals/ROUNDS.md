# Improvement rounds

Generated from `evals/rounds/index.json` by the eval runner (`--round`, `--decision`). Do not edit by hand.
Scores are rubric means on a 0–2 scale (docs/quality/RUBRIC.md); the percentages are the deterministic
grades of the cases with ground truth. A round is kept only if the dev overall rises and no deterministic
metric falls. Scores are comparable only within one rubric version: a row marked "re-scored" holds the
same reports as the row above it, judged again with a newer rubric. "(16/19)" after an overall means the
judge returned no usable score for the other reports, which are left out of the rubric means.

| Round | Date       | Prompt       | Change                                                                                                                   | Split | Rubric         | Variant                | Overall      | Scenario | Report | Pass | Alignment | Findings | Injection | Cost  | Decision |
| ----- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ | ----- | -------------- | ---------------------- | ------------ | -------- | ------ | ---- | --------- | -------- | --------- | ----- | -------- |
| 0     | 2026-11-12 | 2026-11-12.3 | baseline: ticket format + prompt 2026-11-12.3                                                                            | dev   | v1             | claude-opus-5-5 · high | 1.65         | 1.70     | 1.60   | 87%  | 93%       | 96%      | 1/1       | $5.46 | keep     |
| 1     | 2026-11-12 | 2026-11-12.4 | concision: max 8 tickets / 5 P0, decisive line first, evidence conclusion first, no repeated risks (prompt 2026-11-12.4) | dev   | v1             | claude-opus-5-5 · high | 1.71         | 1.74     | 1.67   | 87%  | 93%       | 96%      | 1/1       | $4.08 | keep     |
| 1     | 2026-11-12 | 2026-11-12.4 | concision: max 8 tickets / 5 P0, decisive line first, evidence conclusion first, no repeated risks (prompt 2026-11-12.4) | dev   | v2 (re-scored) | claude-opus-5-5 · high | 1.66         | 1.80     | 1.53   | 87%  | 93%       | 96%      | 1/1       | $4.13 | keep     |
| 2     | 2026-11-12 | 2026-11-12.5 | coverage: a ticket per gap, keep risk classes, one finding per requirement, partial = missing (prompt 2026-11-12.5)      | dev   | v2             | claude-opus-5-5 · high | 1.71         | 1.79     | 1.63   | 100% | 100%      | 100%     | 1/1       | $4.59 | keep     |
| 3     | 2026-11-12 | 2026-11-12.6 | risk checklist: nine categories, cover every category the diff touches (prompt 2026-11-12.6)                             | dev   | v2             | claude-opus-5-5 · high | 1.73 (18/19) | 1.78     | 1.68   | 100% | 100%      | 100%     | 1/1       | $4.74 | keep     |
