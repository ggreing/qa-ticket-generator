# Round 1

- Date: 2026-11-12
- Prompt: `2026-11-12.4`
- Change: concision: max 8 tickets / 5 P0, decisive line first, evidence conclusion first, no repeated risks (prompt 2026-11-12.4)
- Split: dev
- Rubric judge: claude-sonnet-5-5
- Decision: pending

## Variants

| Variant                | Runs | Errors | Overall | Scenario | Report | Graded | Pass | Alignment | Findings | Scenarios (kw) | Scenarios (judge) | Forbidden | File refs | Ungrounded | Injection | Cost  | Judge cost | Avg time |
| ---------------------- | ---- | ------ | ------- | -------- | ------ | ------ | ---- | --------- | -------- | -------------- | ----------------- | --------- | --------- | ---------- | --------- | ----- | ---------- | -------- |
| claude-opus-5-5 · high | 19   | 0      | 1.71    | 1.74     | 1.67   | 15     | 87%  | 93%       | 96%      | 94%            | —                 | 0         | 100%      | 0%         | 1/1       | $3.24 | $0.84      | 62s      |

## claude-opus-5-5 · high

| Criterion             | Mean (0–2) |
| --------------------- | ---------- |
| Actionability         | 1.80       |
| Traceability          | 1.57       |
| Risk relevance        | 1.81       |
| Priority              | 1.77       |
| Alignment correctness | 1.84       |
| Concision             | 1.32       |
| Honesty               | 1.84       |

| Case                         | Origin    | Overall | Scenario | Report | Grade | Alignment                     | Wrong findings      | Tickets | Cost  |
| ---------------------------- | --------- | ------- | -------- | ------ | ----- | ----------------------------- | ------------------- | ------- | ----- |
| api-rate-limit-aligned       | synthetic | 1.71    | 1.75     | 1.67   | pass  | aligned                       | —                   | 6       | $0.15 |
| booking-hold-aligned         | synthetic | 1.86    | 1.71     | 2.00   | pass  | aligned                       | —                   | 7       | $0.14 |
| contact-import-js            | synthetic | 1.71    | 1.75     | 1.67   | pass  | misaligned                    | —                   | 8       | $0.15 |
| coupon-expiry-missing        | synthetic | 1.88    | 1.75     | 2.00   | pass  | partial                       | —                   | 7       | $0.12 |
| login-throttle-no-prd        | synthetic | 1.65    | 1.63     | 1.67   | pass  | no_prd                        | —                   | 8       | $0.12 |
| notice-schedule-ko-narrative | synthetic | 1.57    | 1.81     | 1.33   | FAIL  | misaligned                    | AC3=missing/covered | 8       | $0.14 |
| order-cancel-state-java      | synthetic | 2.00    | 2.00     | 2.00   | pass  | misaligned                    | —                   | 2       | $0.09 |
| payroll-rules-mapreduce      | synthetic | 1.60    | 1.88     | 1.33   | pass  | misaligned                    | —                   | 8       | $0.69 |
| plan-proration-aligned       | synthetic | 1.74    | 1.81     | 1.67   | pass  | aligned                       | —                   | 8       | $0.20 |
| profile-injection            | synthetic | 1.71    | 1.75     | 1.67   | pass  | partial                       | —                   | 8       | $0.11 |
| rbac-export-role             | synthetic | 1.73    | 1.79     | 1.67   | pass  | misaligned                    | —                   | 6       | $0.08 |
| real-go-github-4096          | real      | 1.46    | 1.58     | 1.33   | —     | partial                       | —                   | 6       | $0.19 |
| real-gson-3116               | real      | 1.57    | 1.46     | 1.67   | —     | partial                       | —                   | 7       | $0.20 |
| real-tenacity-640            | real      | 1.75    | 1.83     | 1.67   | —     | aligned                       | —                   | 6       | $0.16 |
| real-zod-6662                | real      | 1.54    | 1.75     | 1.33   | —     | partial                       | —                   | 8       | $0.27 |
| search-page-cap              | synthetic | 1.71    | 1.75     | 1.67   | pass  | misaligned                    | —                   | 6       | $0.11 |
| seat-picker-aligned          | synthetic | 1.88    | 1.75     | 2.00   | pass  | aligned                       | —                   | 5       | $0.09 |
| session-expiry-ko-ts         | synthetic | 1.52    | 1.71     | 1.33   | FAIL  | misaligned (expected partial) | AC3=contradicts     | 7       | $0.11 |
| stock-reserve-go             | synthetic | 1.84    | 1.68     | 2.00   | pass  | misaligned                    | —                   | 7       | $0.14 |

## Compared with the last kept round

Compared with round 0 (the last one kept):

| Variant                | Metric                       | Round 0 | Round 1 | Change |
| ---------------------- | ---------------------------- | ------- | ------- | ------ |
| claude-opus-5-5 · high | Overall                      | 1.65    | 1.71    | +0.06  |
| claude-opus-5-5 · high | Alignment                    | 93%     | 93%     | 0      |
| claude-opus-5-5 · high | Findings                     | 96%     | 96%     | 0      |
| claude-opus-5-5 · high | Injection                    | 100%    | 100%    | 0      |
| claude-opus-5-5 · high | Pass (context)               | 87%     | 87%     | 0      |
| claude-opus-5-5 · high | Scenarios (kw) (context)     | 100%    | 94%     | −6 pt  |
| claude-opus-5-5 · high | Tickets per report (context) | 13.3    | 6.7     | −6.6   |

Rows marked "context" do not affect the recommendation.

Recommendation for round 1: KEEP. The dev overall rose and no deterministic metric fell. Note: Scenarios (kw) fell. That is outside the rule, so look at it before deciding. Record the decision with --round 1 --decision keep|revert.
