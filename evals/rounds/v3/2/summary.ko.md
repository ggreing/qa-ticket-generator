# Round 2 (v3 plan)

- Date: 2026-11-16
- Prompt: `2026-11-16.1`
- Change: prompt 2026-11-16.1: seven questions a requirement does not ask for (who else, zero/same, per what, across the line, and then, other thing's state, what comes back)
- Split: selected
- Language: ko
- Rubric judge: claude-sonnet-5-5, rubric v3.2
- Must-cover checked by: coverage judge (any language)
- Style violations counted by: lintCaseStyle
- Decision: revert
- Scored again on 2026-11-16: second-order combinations (coverage judge) and deterministic metrics. The sheets are the ones written on the date above.

## Run

| Variant                | Specs | Errors | Overall | Case | Sheet | Spec coverage | Cases/spec | Must-cover (kw) | Must-cover (judge) | 2nd-order recall | Req. with a case | Style viol./100 | Repeated titles | Merged away | Cost  | Judge cost |
| ---------------------- | ----- | ------ | ------- | ---- | ----- | ------------- | ---------- | --------------- | ------------------ | ---------------- | ---------------- | --------------- | --------------- | ----------- | ----- | ---------- |
| claude-opus-5-5 · high | 14    | 0      | 1.75    | 1.83 | 1.67  | 1.93          | 42.8       | 61%             | 100%               | 91%              | 100%             | 0.0             | 0               | 5           | $8.37 | $1.00      |

| Criterion          | Mean (0–2) |
| ------------------ | ---------- |
| Actionability      | 1.76       |
| Traceability       | 1.79       |
| Priority           | 1.91       |
| Easy-to-miss value | 1.68       |
| QA-sheet style     | 2.00       |
| Spec coverage      | 1.93       |
| No duplicates      | 1.14       |
| Honesty            | 1.93       |

## Per spec

| Spec                         | Cases | P0  | Overall | Spec coverage | Must-cover (kw) | Must-cover (judge) | 2nd-order | Reqs without a case | Style viol. | Merged away | Cost  |
| ---------------------------- | ----- | --- | ------- | ------------- | --------------- | ------------------ | --------- | ------------------- | ----------- | ----------- | ----- |
| api-rate-limit-aligned       | 45    | 13  | 1.74    | 2             | 80%             | 100%               | 6/6       | —                   | 0           | 0           | $0.73 |
| booking-hold-aligned         | 30    | 9   | 1.55    | 2             | 25%             | 100%               | 7/7       | —                   | 0           | 0           | $0.54 |
| contact-import-js            | 41    | 12  | 1.75    | 2             | 40%             | 100%               | 6/7       | —                   | 0           | 0           | $0.46 |
| coupon-expiry-missing        | 53    | 14  | 1.76    | 2             | 100%            | 100%               | 6/7       | —                   | 0           | 0           | $0.70 |
| notice-schedule-ko-narrative | 44    | 8   | 1.72    | 2             | 100%            | 100%               | 7/7       | —                   | 0           | 0           | $0.49 |
| order-cancel-state-java      | 41    | 24  | 1.75    | 2             | 83%             | 100%               | 6/7       | —                   | 0           | 4           | $0.66 |
| payroll-rules-mapreduce      | 56    | 11  | 1.62    | 1             | 33%             | 100%               | 8/8       | —                   | 0           | 0           | $1.03 |
| plan-proration-aligned       | 52    | 17  | 1.77    | 2             | 20%             | 100%               | 6/7       | —                   | 0           | 1           | $0.97 |
| profile-injection            | 40    | 4   | 1.94    | 2             | 67%             | 100%               | 7/7       | —                   | 0           | 0           | $0.39 |
| rbac-export-role             | 35    | 8   | 1.74    | 2             | 75%             | 100%               | 7/7       | —                   | 0           | 0           | $0.42 |
| search-page-cap              | 41    | 8   | 1.74    | 2             | 25%             | 100%               | 8/8       | —                   | 0           | 0           | $0.54 |
| seat-picker-aligned          | 46    | 10  | 1.73    | 2             | 60%             | 100%               | 3/5       | —                   | 0           | 0           | $0.59 |
| session-expiry-ko-ts         | 42    | 9   | 1.72    | 2             | 100%            | 100%               | 5/7       | —                   | 0           | 0           | $0.51 |
| stock-reserve-go             | 33    | 14  | 1.94    | 2             | 60%             | 100%               | 5/6       | —                   | 0           | 0           | $0.35 |

## Second-order combinations with no case

From the fixed list in `expected.secondOrder`. This list does not change between rounds.

- contact-import-js: skipped-line-numbers
- coupon-expiry-missing: zero-percent
- order-cancel-state-java: partially-refunded-order
- plan-proration-aligned: undo-scheduled-downgrade
- seat-picker-aligned: back-from-continue
- seat-picker-aligned: sold-out-showtime
- session-expiry-ko-ts: logout-again
- session-expiry-ko-ts: logout-other-users-session
- stock-reserve-go: other-users-reservation

## What the rubric judge found missing

- payroll-rules-mapreduce: Rounding / boundary: exact half-cent rounds up case with concrete values

## Cases the merge step removed

Check that each one really repeats the case it was folded into.

- order-cancel-state-java: "전이 성공 시 order_status_history 행 기록" removed as a repeat of "정상 전환 3단계 시 이력 3행 기록" (merge: Both start from a PENDING order with zero history rows, run the full PENDING→PAID→SHIPPED→DELIVERED sequence with a given actor, and check that exactly three order_status_history rows are written.)
- order-cancel-state-java: "이력 기록 실패 시 상태 변경 처리" removed as a repeat of "이력 저장 실패 시 상태만 변경된 주문 없음" (merge: Both start from a PAID order with order_status_history writes forced to fail, request PAID→SHIPPED, and check that the order never ends up SHIPPED without a matching history row.)
- order-cancel-state-java: "동일 PAID 주문 동시 취소 2건 시 환불 1회" removed as a repeat of "PAID 주문 취소 요청 동시 2건 시 환불 1회" (merge: Both send two simultaneous cancel requests for the same captured PAID order and check that the gateway issues exactly one refund of the captured amount.)
- order-cancel-state-java: "게이트웨이 타임아웃 후 취소 재시도 시 중복 환불 없음" removed as a repeat of "게이트웨이 타임아웃 후 재요청 시 이중 환불 없음" (merge: Both cancel a captured PAID order whose gateway processes the refund but times out the response, retry the cancel, and check that the total refunded does not exceed the captured amount.)
- plan-proration-aligned: "결제 승인 후 플랜 변경 저장 실패 시 청구만 남지 않음" removed as a repeat of "결제 승인 후 플랜 저장 실패 시 결제만 남지 않음" (merge: Both start from a Basic subscription upgrading to Pro with a valid card, inject a failure in the plan-save step after the payment is approved, and observe that no confirmed charge is left while the plan stays Basic.)

## Compared with the last kept round

Compared with round 1 (the last one kept):

| Metric                             | Round 1 | Round 2 |        |
| ---------------------------------- | ------- | ------- | ------ |
| Overall                            | 1.82    | 1.75    | worse  |
| Must-cover (judge)                 | 100%    | 100%    | same   |
| 2nd-order recall                   | 82%     | 91%     | better |
| Req. with a case                   | 100%    | 100%    | same   |
| Style viol./100                    | 0.0     | 0.0     | same   |
| Cases/spec (context)               | 39.2    | 42.8    | better |
| Merged away (context)              | 7       | 5       | —      |
| Actionability (0–2) (context)      | 1.80    | 1.76    | worse  |
| Traceability (0–2) (context)       | 1.85    | 1.79    | worse  |
| Priority (0–2) (context)           | 1.94    | 1.91    | worse  |
| Easy-to-miss value (0–2) (context) | 1.70    | 1.68    | worse  |
| QA-sheet style (0–2) (context)     | 2.00    | 2.00    | same   |
| Spec coverage (0–2) (context)      | 2.00    | 1.93    | worse  |
| No duplicates (0–2) (context)      | 1.36    | 1.14    | worse  |
| Honesty (0–2) (context)            | 2.00    | 1.93    | worse  |

Rows marked "context" do not affect the recommendation.

Recommendation for round 2: REVERT. The overall did not rise. Record the decision with plan --round 2 --decision keep|revert.
