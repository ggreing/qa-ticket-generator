# Round 2

- Date: 2026-11-12
- Prompt: `2026-11-12.5`
- Change: coverage: a ticket per gap, keep risk classes, one finding per requirement, partial = missing (prompt 2026-11-12.5)
- Split: dev
- Rubric judge: claude-sonnet-5-5, rubric v2
- Decision: keep

## Variants

| Variant                | Runs | Errors | Overall | Scenario | Report | Graded | Pass | Alignment | Findings | Scenarios (kw) | Scenarios (judge) | Forbidden | File refs | Ungrounded | Injection | Cost  | Judge cost | Avg time |
| ---------------------- | ---- | ------ | ------- | -------- | ------ | ------ | ---- | --------- | -------- | -------------- | ----------------- | --------- | --------- | ---------- | --------- | ----- | ---------- | -------- |
| claude-opus-5-5 · high | 19   | 0      | 1.71    | 1.79     | 1.63   | 15     | 100% | 100%      | 100%     | 100%           | —                 | 0         | 100%      | 0%         | 1/1       | $3.64 | $0.95      | 73s      |

## claude-opus-5-5 · high

| Criterion             | Mean (0–2) |
| --------------------- | ---------- |
| Actionability         | 1.80       |
| Traceability          | 1.82       |
| Risk relevance        | 1.80       |
| Priority              | 1.76       |
| Alignment correctness | 1.89       |
| Concision             | 1.58       |
| Honesty               | 1.95       |
| Coverage              | 1.11       |

| Case                         | Origin    | Overall | Scenario | Report | Grade | Alignment  | Wrong findings | Tickets | Scored | Cost  |
| ---------------------------- | --------- | ------- | -------- | ------ | ----- | ---------- | -------------- | ------- | ------ | ----- |
| api-rate-limit-aligned       | synthetic | 1.65    | 1.79     | 1.50   | pass  | aligned    | —              | 6       | 6/6    | $0.15 |
| booking-hold-aligned         | synthetic | 1.68    | 1.86     | 1.50   | pass  | aligned    | —              | 7       | 7/7    | $0.16 |
| contact-import-js            | synthetic | 1.97    | 1.94     | 2.00   | pass  | misaligned | —              | 8       | 8/8    | $0.18 |
| coupon-expiry-missing        | synthetic | 1.55    | 1.84     | 1.25   | pass  | partial    | —              | 8       | 8/8    | $0.15 |
| login-throttle-no-prd        | synthetic | 1.78    | 1.81     | 1.75   | pass  | no_prd     | —              | 8       | 8/8    | $0.12 |
| notice-schedule-ko-narrative | synthetic | 1.75    | 1.75     | 1.75   | pass  | misaligned | —              | 8       | 8/8    | $0.15 |
| order-cancel-state-java      | synthetic | 1.82    | 1.89     | 1.75   | pass  | misaligned | —              | 7       | 7/7    | $0.15 |
| payroll-rules-mapreduce      | synthetic | 1.69    | 1.88     | 1.50   | pass  | misaligned | —              | 8       | 8/8    | $0.82 |
| plan-proration-aligned       | synthetic | 1.67    | 1.84     | 1.50   | pass  | aligned    | —              | 8       | 8/8    | $0.19 |
| profile-injection            | synthetic | 1.77    | 1.78     | 1.75   | pass  | partial    | —              | 8       | 8/8    | $0.12 |
| rbac-export-role             | synthetic | 1.93    | 1.86     | 2.00   | pass  | misaligned | —              | 7       | 7/7    | $0.10 |
| real-go-github-4096          | real      | 1.68    | 1.61     | 1.75   | —     | misaligned | —              | 7       | 7/7    | $0.19 |
| real-gson-3116               | real      | 1.68    | 1.61     | 1.75   | —     | partial    | —              | 7       | 7/7    | $0.20 |
| real-tenacity-640            | real      | 1.70    | 1.89     | 1.50   | —     | aligned    | —              | 7       | 7/7    | $0.17 |
| real-zod-6662                | real      | 1.44    | 1.63     | 1.25   | —     | partial    | —              | 8       | 8/8    | $0.30 |
| search-page-cap              | synthetic | 1.68    | 1.86     | 1.50   | pass  | misaligned | —              | 7       | 7/7    | $0.12 |
| seat-picker-aligned          | synthetic | 1.55    | 1.60     | 1.50   | pass  | aligned    | —              | 5       | 5/5    | $0.11 |
| session-expiry-ko-ts         | synthetic | 1.79    | 1.83     | 1.75   | pass  | partial    | —              | 6       | 6/6    | $0.12 |
| stock-reserve-go             | synthetic | 1.77    | 1.79     | 1.75   | pass  | misaligned | —              | 6       | 6/6    | $0.14 |

## Compared with the last kept round

Compared with round 1 (the last one kept):

| Variant                | Metric                                | Round 1 | Round 2 | Change |
| ---------------------- | ------------------------------------- | ------- | ------- | ------ |
| claude-opus-5-5 · high | Overall                               | 1.66    | 1.71    | +0.05  |
| claude-opus-5-5 · high | Alignment                             | 93%     | 100%    | +7 pt  |
| claude-opus-5-5 · high | Findings                              | 96%     | 100%    | +4 pt  |
| claude-opus-5-5 · high | Injection                             | 100%    | 100%    | 0      |
| claude-opus-5-5 · high | Pass (context)                        | 87%     | 100%    | +13 pt |
| claude-opus-5-5 · high | Scenarios (kw) (context)              | 94%     | 100%    | +6 pt  |
| claude-opus-5-5 · high | Tickets per report (context)          | 6.7     | 7.2     | +0.4   |
| claude-opus-5-5 · high | Actionability (0–2) (context)         | 1.89    | 1.80    | −0.09  |
| claude-opus-5-5 · high | Traceability (0–2) (context)          | 1.75    | 1.82    | +0.07  |
| claude-opus-5-5 · high | Risk relevance (0–2) (context)        | 1.76    | 1.80    | +0.04  |
| claude-opus-5-5 · high | Priority (0–2) (context)              | 1.78    | 1.76    | −0.02  |
| claude-opus-5-5 · high | Alignment correctness (0–2) (context) | 1.84    | 1.89    | +0.05  |
| claude-opus-5-5 · high | Concision (0–2) (context)             | 1.74    | 1.58    | −0.16  |
| claude-opus-5-5 · high | Honesty (0–2) (context)               | 1.89    | 1.95    | +0.05  |
| claude-opus-5-5 · high | Coverage (0–2) (context)              | 0.63    | 1.11    | +0.47  |

Rows marked "context" do not affect the recommendation.

Recommendation for round 2: KEEP. The dev overall rose and no deterministic metric fell. Record the decision with --round 2 --decision keep|revert.
