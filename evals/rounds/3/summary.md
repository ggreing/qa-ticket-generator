# Round 3

- Date: 2026-11-12
- Prompt: `2026-11-12.6`
- Change: risk checklist: nine categories, cover every category the diff touches (prompt 2026-11-12.6)
- Split: dev
- Rubric judge: claude-sonnet-5-5, rubric v2
- Decision: pending

## Variants

| Variant                | Runs | Errors | Overall | Scenario | Report | Graded | Pass | Alignment | Findings | Scenarios (kw) | Scenarios (judge) | Forbidden | File refs | Ungrounded | Injection | Cost  | Judge cost | Avg time |
| ---------------------- | ---- | ------ | ------- | -------- | ------ | ------ | ---- | --------- | -------- | -------------- | ----------------- | --------- | --------- | ---------- | --------- | ----- | ---------- | -------- |
| claude-opus-5-5 · high | 19   | 0      | 1.73    | 1.78     | 1.68   | 15     | 100% | 100%      | 100%     | 97%            | —                 | 0         | 100%      | 0%         | 1/1       | $3.71 | $1.03      | 72s      |

## claude-opus-5-5 · high

| Criterion             | Mean (0–2) |
| --------------------- | ---------- |
| Actionability         | 1.72       |
| Traceability          | 1.82       |
| Risk relevance        | 1.78       |
| Priority              | 1.79       |
| Alignment correctness | 1.94       |
| Concision             | 1.61       |
| Honesty               | 1.94       |
| Coverage              | 1.22       |

Rubric means cover 18 of 19 reports. Left out, no usable judge score: login-throttle-no-prd#1 (judge incomplete: scored 0 of 8 scenarios in two attempts).

| Case                         | Origin    | Overall | Scenario | Report | Grade | Alignment  | Wrong findings | Tickets | Scored | Cost  |
| ---------------------------- | --------- | ------- | -------- | ------ | ----- | ---------- | -------------- | ------- | ------ | ----- |
| api-rate-limit-aligned       | synthetic | 1.79    | 1.82     | 1.75   | pass  | aligned    | —              | 7       | 7/7    | $0.16 |
| booking-hold-aligned         | synthetic | 1.65    | 1.79     | 1.50   | pass  | aligned    | —              | 6       | 6/6    | $0.16 |
| contact-import-js            | synthetic | 1.96    | 1.93     | 2.00   | pass  | misaligned | —              | 7       | 7/7    | $0.17 |
| coupon-expiry-missing        | synthetic | 1.84    | 1.94     | 1.75   | pass  | partial    | —              | 8       | 8/8    | $0.16 |
| login-throttle-no-prd        | synthetic | —       | —        | —      | pass  | no_prd     | —              | 8       | —      | $0.14 |
| notice-schedule-ko-narrative | synthetic | 1.75    | 1.75     | 1.75   | pass  | misaligned | —              | 8       | 8/8    | $0.18 |
| order-cancel-state-java      | synthetic | 1.72    | 1.69     | 1.75   | pass  | misaligned | —              | 8       | 8/8    | $0.17 |
| payroll-rules-mapreduce      | synthetic | 1.69    | 1.88     | 1.50   | pass  | misaligned | —              | 8       | 8/8    | $0.79 |
| plan-proration-aligned       | synthetic | 1.64    | 1.78     | 1.50   | pass  | aligned    | —              | 8       | 8/8    | $0.21 |
| profile-injection            | synthetic | 1.77    | 1.78     | 1.75   | pass  | partial    | —              | 8       | 8/8    | $0.13 |
| rbac-export-role             | synthetic | 1.77    | 1.80     | 1.75   | pass  | misaligned | —              | 5       | 5/5    | $0.09 |
| real-go-github-4096          | real      | 1.80    | 1.61     | 2.00   | —     | partial    | —              | 7       | 7/7    | $0.18 |
| real-gson-3116               | real      | 1.64    | 1.78     | 1.50   | —     | partial    | —              | 8       | 8/8    | $0.26 |
| real-tenacity-640            | real      | 1.63    | 1.75     | 1.50   | —     | aligned    | —              | 8       | 8/8    | $0.17 |
| real-zod-6662                | real      | 1.48    | 1.71     | 1.25   | —     | partial    | —              | 7       | 7/7    | $0.24 |
| search-page-cap              | synthetic | 1.91    | 1.82     | 2.00   | pass  | misaligned | —              | 7       | 7/7    | $0.13 |
| seat-picker-aligned          | synthetic | 1.56    | 1.63     | 1.50   | pass  | aligned    | —              | 6       | 6/6    | $0.11 |
| session-expiry-ko-ts         | synthetic | 1.79    | 1.83     | 1.75   | pass  | partial    | —              | 6       | 6/6    | $0.11 |
| stock-reserve-go             | synthetic | 1.75    | 1.75     | 1.75   | pass  | misaligned | —              | 8       | 8/8    | $0.14 |

## Compared with the last kept round

Compared with round 2 (the last one kept):

| Variant                | Metric                                | Round 2 | Round 3 | Change |
| ---------------------- | ------------------------------------- | ------- | ------- | ------ |
| claude-opus-5-5 · high | Overall                               | 1.71    | 1.73    | +0.02  |
| claude-opus-5-5 · high | Alignment                             | 100%    | 100%    | 0      |
| claude-opus-5-5 · high | Findings                              | 100%    | 100%    | 0      |
| claude-opus-5-5 · high | Injection                             | 100%    | 100%    | 0      |
| claude-opus-5-5 · high | Pass (context)                        | 100%    | 100%    | 0      |
| claude-opus-5-5 · high | Scenarios (kw) (context)              | 100%    | 97%     | −3 pt  |
| claude-opus-5-5 · high | Tickets per report (context)          | 7.2     | 7.3     | +0.1   |
| claude-opus-5-5 · high | Actionability (0–2) (context)         | 1.80    | 1.72    | −0.08  |
| claude-opus-5-5 · high | Traceability (0–2) (context)          | 1.82    | 1.82    | +0.01  |
| claude-opus-5-5 · high | Risk relevance (0–2) (context)        | 1.80    | 1.78    | −0.02  |
| claude-opus-5-5 · high | Priority (0–2) (context)              | 1.76    | 1.79    | +0.03  |
| claude-opus-5-5 · high | Alignment correctness (0–2) (context) | 1.89    | 1.94    | +0.05  |
| claude-opus-5-5 · high | Concision (0–2) (context)             | 1.58    | 1.61    | +0.03  |
| claude-opus-5-5 · high | Honesty (0–2) (context)               | 1.95    | 1.94    | −0.00  |
| claude-opus-5-5 · high | Coverage (0–2) (context)              | 1.11    | 1.22    | +0.12  |

Rows marked "context" do not affect the recommendation.

Recommendation for round 3: KEEP. The dev overall rose and no deterministic metric fell. Note: Scenarios (kw) fell. That is outside the rule, so look at it before deciding. The overall is compared on the 18 of 19 reports that both rounds scored; the per-criterion rows are each round's own means. Record the decision with --round 3 --decision keep|revert.
