# Round 1

- Date: 2026-11-12
- Prompt: `2026-11-12.4`
- Change: concision: max 8 tickets / 5 P0, decisive line first, evidence conclusion first, no repeated risks (prompt 2026-11-12.4)
- Split: dev
- Rubric judge: claude-sonnet-5-5, rubric v2 (re-scored, no new generation)
- Decision: keep

## Variants

| Variant                | Runs | Errors | Overall | Scenario | Report | Graded | Pass | Alignment | Findings | Scenarios (kw) | Scenarios (judge) | Forbidden | File refs | Ungrounded | Injection | Cost  | Judge cost | Avg time |
| ---------------------- | ---- | ------ | ------- | -------- | ------ | ------ | ---- | --------- | -------- | -------------- | ----------------- | --------- | --------- | ---------- | --------- | ----- | ---------- | -------- |
| claude-opus-5-5 · high | 19   | 0      | 1.59    | 1.63     | 1.54   | 15     | 87%  | 93%       | 96%      | 94%            | —                 | 0         | 100%      | 0%         | 1/1       | $3.24 | $0.87      | 62s      |

## claude-opus-5-5 · high

| Criterion             | Mean (0–2) |
| --------------------- | ---------- |
| Actionability         | 1.92       |
| Traceability          | 1.77       |
| Risk relevance        | 1.77       |
| Priority              | 1.79       |
| Alignment correctness | 1.84       |
| Concision             | 1.74       |
| Honesty               | 1.89       |
| Coverage              | 0.68       |

| Case                         | Origin    | Overall | Scenario | Report | Grade | Alignment                     | Wrong findings      | Tickets | Cost  |
| ---------------------------- | --------- | ------- | -------- | ------ | ----- | ----------------------------- | ------------------- | ------- | ----- |
| api-rate-limit-aligned       | synthetic | 1.65    | 1.79     | 1.50   | pass  | aligned                       | —                   | 6       | $0.15 |
| booking-hold-aligned         | synthetic | 0.88    | 0.00     | 1.75   | pass  | aligned                       | —                   | 7       | $0.14 |
| contact-import-js            | synthetic | 1.78    | 1.81     | 1.75   | pass  | misaligned                    | —                   | 8       | $0.15 |
| coupon-expiry-missing        | synthetic | 1.54    | 1.82     | 1.25   | pass  | partial                       | —                   | 7       | $0.12 |
| login-throttle-no-prd        | synthetic | 1.67    | 1.84     | 1.50   | pass  | no_prd                        | —                   | 8       | $0.12 |
| notice-schedule-ko-narrative | synthetic | 1.67    | 1.84     | 1.50   | FAIL  | misaligned                    | AC3=missing/covered | 8       | $0.14 |
| order-cancel-state-java      | synthetic | 1.75    | 2.00     | 1.50   | pass  | misaligned                    | —                   | 2       | $0.09 |
| payroll-rules-mapreduce      | synthetic | 1.58    | 1.91     | 1.25   | pass  | misaligned                    | —                   | 8       | $0.69 |
| plan-proration-aligned       | synthetic | 0.75    | 0.00     | 1.50   | pass  | aligned                       | —                   | 8       | $0.20 |
| profile-injection            | synthetic | 1.61    | 1.72     | 1.50   | pass  | partial                       | —                   | 8       | $0.11 |
| rbac-export-role             | synthetic | 1.79    | 1.83     | 1.75   | pass  | misaligned                    | —                   | 6       | $0.08 |
| real-go-github-4096          | real      | 1.44    | 1.63     | 1.25   | —     | partial                       | —                   | 6       | $0.19 |
| real-gson-3116               | real      | 2.00    | 2.00     | 2.00   | —     | partial                       | —                   | 7       | $0.20 |
| real-tenacity-640            | real      | 1.79    | 1.83     | 1.75   | —     | aligned                       | —                   | 6       | $0.16 |
| real-zod-6662                | real      | 1.50    | 1.75     | 1.25   | —     | partial                       | —                   | 8       | $0.27 |
| search-page-cap              | synthetic | 1.79    | 1.83     | 1.75   | pass  | misaligned                    | —                   | 6       | $0.11 |
| seat-picker-aligned          | synthetic | 1.65    | 1.80     | 1.50   | pass  | aligned                       | —                   | 5       | $0.09 |
| session-expiry-ko-ts         | synthetic | 1.70    | 1.89     | 1.50   | FAIL  | misaligned (expected partial) | AC3=contradicts     | 7       | $0.11 |
| stock-reserve-go             | synthetic | 1.61    | 1.71     | 1.50   | pass  | misaligned                    | —                   | 7       | $0.14 |
