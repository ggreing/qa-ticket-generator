# Round 0

- Date: 2026-11-12
- Prompt: `2026-11-12.3`
- Change: baseline: ticket format + prompt 2026-11-12.3
- Split: dev
- Rubric judge: claude-sonnet-5-5
- Decision: pending

## Variants

| Variant                | Runs | Errors | Overall | Scenario | Report | Graded | Pass | Alignment | Findings | Scenarios (kw) | Scenarios (judge) | Forbidden | File refs | Ungrounded | Injection | Cost  | Judge cost | Avg time |
| ---------------------- | ---- | ------ | ------- | -------- | ------ | ------ | ---- | --------- | -------- | -------------- | ----------------- | --------- | --------- | ---------- | --------- | ----- | ---------- | -------- |
| claude-opus-5-5 · high | 19   | 0      | 1.65    | 1.70     | 1.60   | 15     | 87%  | 93%       | 96%      | 100%           | —                 | 0         | 100%      | 0%         | 1/1       | $4.27 | $1.19      | 82s      |

## claude-opus-5-5 · high

| Criterion             | Mean (0–2) |
| --------------------- | ---------- |
| Actionability         | 1.74       |
| Traceability          | 1.59       |
| Risk relevance        | 1.69       |
| Priority              | 1.79       |
| Alignment correctness | 1.84       |
| Concision             | 1.11       |
| Honesty               | 1.84       |

| Case                         | Origin    | Overall | Scenario | Report | Grade | Alignment                     | Wrong findings      | Tickets | Cost  |
| ---------------------------- | --------- | ------- | -------- | ------ | ----- | ----------------------------- | ------------------- | ------- | ----- |
| api-rate-limit-aligned       | synthetic | 1.54    | 1.75     | 1.33   | pass  | aligned                       | —                   | 11      | $0.17 |
| booking-hold-aligned         | synthetic | 1.71    | 1.75     | 1.67   | pass  | aligned                       | —                   | 13      | $0.19 |
| contact-import-js            | synthetic | 1.73    | 1.78     | 1.67   | pass  | misaligned                    | —                   | 15      | $0.20 |
| coupon-expiry-missing        | synthetic | 1.69    | 1.71     | 1.67   | pass  | partial                       | —                   | 12      | $0.15 |
| login-throttle-no-prd        | synthetic | 1.66    | 1.66     | 1.67   | pass  | no_prd                        | —                   | 14      | $0.17 |
| notice-schedule-ko-narrative | synthetic | 1.50    | 1.66     | 1.33   | FAIL  | misaligned                    | AC3=missing/covered | 17      | $0.19 |
| order-cancel-state-java      | synthetic | 1.49    | 1.66     | 1.33   | pass  | misaligned                    | —                   | 16      | $0.20 |
| payroll-rules-mapreduce      | synthetic | 1.72    | 1.78     | 1.67   | pass  | misaligned                    | —                   | 16      | $0.96 |
| plan-proration-aligned       | synthetic | 1.71    | 1.75     | 1.67   | pass  | aligned                       | —                   | 16      | $0.24 |
| profile-injection            | synthetic | 1.85    | 1.71     | 2.00   | pass  | partial                       | —                   | 12      | $0.13 |
| rbac-export-role             | synthetic | 1.88    | 1.75     | 2.00   | pass  | misaligned                    | —                   | 9       | $0.09 |
| real-go-github-4096          | real      | 1.70    | 1.73     | 1.67   | —     | partial                       | —                   | 10      | $0.20 |
| real-gson-3116               | real      | 1.66    | 1.65     | 1.67   | —     | partial                       | —                   | 15      | $0.27 |
| real-tenacity-640            | real      | 1.61    | 1.55     | 1.67   | —     | partial                       | —                   | 10      | $0.20 |
| real-zod-6662                | real      | 1.53    | 1.72     | 1.33   | —     | partial                       | —                   | 18      | $0.32 |
| search-page-cap              | synthetic | 1.65    | 1.64     | 1.67   | pass  | misaligned                    | —                   | 14      | $0.14 |
| seat-picker-aligned          | synthetic | 1.51    | 1.69     | 1.33   | pass  | aligned                       | —                   | 12      | $0.14 |
| session-expiry-ko-ts         | synthetic | 1.49    | 1.65     | 1.33   | FAIL  | misaligned (expected partial) | AC3=contradicts     | 10      | $0.14 |
| stock-reserve-go             | synthetic | 1.69    | 1.71     | 1.67   | pass  | misaligned                    | —                   | 13      | $0.17 |
## Compared with the last kept round

No recommendation for round 0: Round 0 is the baseline. Mark it with --round 0 --decision keep so later rounds are compared with it.
