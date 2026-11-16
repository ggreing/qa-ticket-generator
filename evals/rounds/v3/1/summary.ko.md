# Round 1 (v3 plan)

- Date: 2026-11-13
- Prompt: `2026-11-13.2`
- Change: prompt 2026-11-13.2: one intent one case, open outcomes as questions, merge with reasons
- Split: selected
- Language: ko
- Rubric judge: claude-sonnet-5-5, rubric v3.2
- Must-cover checked by: coverage judge (any language)
- Style violations counted by: lintCaseStyle
- Decision: keep
- Scored again on 2026-11-16: second-order combinations (coverage judge) and deterministic metrics. The sheets are the ones written on the date above.

## Run

| Variant                | Specs | Errors | Overall | Case | Sheet | Spec coverage | Cases/spec | Must-cover (kw) | Must-cover (judge) | 2nd-order recall | Req. with a case | Style viol./100 | Repeated titles | Merged away | Cost  | Judge cost |
| ---------------------- | ----- | ------ | ------- | ---- | ----- | ------------- | ---------- | --------------- | ------------------ | ---------------- | ---------------- | --------------- | --------------- | ----------- | ----- | ---------- |
| claude-opus-5-5 · high | 14    | 0      | 1.82    | 1.86 | 1.79  | 2.00          | 39.2       | 56%             | 100%               | 82%              | 100%             | 0.0             | 0               | 7           | $7.42 | $0.99      |

| Criterion          | Mean (0–2) |
| ------------------ | ---------- |
| Actionability      | 1.80       |
| Traceability       | 1.85       |
| Priority           | 1.94       |
| Easy-to-miss value | 1.70       |
| QA-sheet style     | 2.00       |
| Spec coverage      | 2.00       |
| No duplicates      | 1.36       |
| Honesty            | 2.00       |

## Per spec

| Spec                         | Cases | P0  | Overall | Spec coverage | Must-cover (kw) | Must-cover (judge) | 2nd-order | Reqs without a case | Style viol. | Merged away | Cost  |
| ---------------------------- | ----- | --- | ------- | ------------- | --------------- | ------------------ | --------- | ------------------- | ----------- | ----------- | ----- |
| api-rate-limit-aligned       | 39    | 12  | 1.93    | 2             | 80%             | 100%               | 5/6       | —                   | 0           | 1           | $0.66 |
| booking-hold-aligned         | 29    | 6   | 1.76    | 2             | 25%             | 100%               | 7/7       | —                   | 0           | 0           | $0.37 |
| contact-import-js            | 34    | 8   | 1.72    | 2             | 40%             | 100%               | 5/7       | —                   | 0           | 0           | $0.43 |
| coupon-expiry-missing        | 45    | 18  | 1.79    | 2             | 50%             | 100%               | 5/7       | —                   | 0           | 0           | $0.63 |
| notice-schedule-ko-narrative | 43    | 9   | 1.91    | 2             | 100%            | 100%               | 4/7       | —                   | 0           | 0           | $0.40 |
| order-cancel-state-java      | 38    | 21  | 1.76    | 2             | 83%             | 100%               | 6/7       | —                   | 0           | 5           | $0.61 |
| payroll-rules-mapreduce      | 52    | 10  | 1.77    | 2             | 67%             | 100%               | 8/8       | —                   | 0           | 0           | $0.89 |
| plan-proration-aligned       | 50    | 11  | 1.94    | 2             | 20%             | 100%               | 5/7       | —                   | 0           | 1           | $0.97 |
| profile-injection            | 34    | 4   | 1.74    | 2             | 0%              | 100%               | 7/7       | —                   | 0           | 0           | $0.34 |
| rbac-export-role             | 32    | 8   | 1.80    | 2             | 100%            | 100%               | 7/7       | —                   | 0           | 0           | $0.38 |
| search-page-cap              | 43    | 6   | 1.77    | 2             | 25%             | 100%               | 8/8       | —                   | 0           | 0           | $0.49 |
| seat-picker-aligned          | 39    | 9   | 1.74    | 2             | 40%             | 100%               | 3/5       | —                   | 0           | 0           | $0.51 |
| session-expiry-ko-ts         | 38    | 9   | 1.97    | 2             | 100%            | 100%               | 6/7       | —                   | 0           | 0           | $0.48 |
| stock-reserve-go             | 33    | 12  | 1.92    | 2             | 40%             | 100%               | 3/6       | —                   | 0           | 0           | $0.26 |

## Second-order combinations with no case

From the fixed list in `expected.secondOrder`. This list does not change between rounds.

- api-rate-limit-aligned: too-many-body
- contact-import-js: deleted-contact-match
- contact-import-js: skipped-line-numbers
- coupon-expiry-missing: discount-above-total
- coupon-expiry-missing: reuse-after-refund
- notice-schedule-ko-narrative: resend-failed-notice
- notice-schedule-ko-narrative: reschedule-too-soon
- notice-schedule-ko-narrative: far-future-schedule
- order-cancel-state-java: partially-refunded-order
- plan-proration-aligned: same-price-change
- plan-proration-aligned: undo-scheduled-downgrade
- seat-picker-aligned: fast-clicks-at-limit
- seat-picker-aligned: sold-out-showtime
- session-expiry-ko-ts: logout-other-users-session
- stock-reserve-go: other-users-reservation
- stock-reserve-go: expire-together
- stock-reserve-go: confirm-twice

## Cases the merge step removed

Check that each one really repeats the case it was folded into.

- api-rate-limit-aligned: "한 키 병렬 150건 시 성공 정확히 100건" removed as a repeat of "병렬 150건 응답 합계 150건, 5xx·무응답 없음" (merge: Both cases send 150 parallel requests with key A (key_partner_a), starting from 0 requests in the last 60 seconds, and both check for exactly 100 HTTP 200 responses. Case 35 also checks for 50 HTTP 429s and no 5xx or missing responses, so running it covers case 30.)
- order-cancel-state-java: "동일 주문 취소 동시 2건 요청 시 환불 1회" removed as a repeat of "PAID 주문 동시 취소 2건 시 환불 1회" (merge: Both send two concurrent cancel requests from CS agents for the same PAID order captured at 50,000 and check that the gateway refunds exactly once.)
- order-cancel-state-java: "PAID 주문 취소 중 게이트웨이 장애 시 상태 불일치 없음" removed as a repeat of "게이트웨이 장애 시 PAID 주문 취소 결과" (merge: Both cancel a PAID order while the gateway refund API returns 503 and check that no order is left cancelled without a refund or a record of the pending refund.)
- order-cancel-state-java: "환불 응답 타임아웃 후 재취소 시 중복 환불 없음" removed as a repeat of "환불 응답 타임아웃 후 재취소 시 이중 환불 없음" (merge: Both cancel a PAID order where the gateway processes the refund but the response times out, then cancel again, and check that the total refunded does not exceed the captured amount.)
- order-cancel-state-java: "PAID 주문 취소 시 이력 행 기록" removed as a repeat of "취소 성공 시 이전 상태·취소·actor id 이력 기록" (merge: Both have a CS agent cancel a PAID order successfully and check that a new order_status_history row is written for it; 21 also checks the previous status, new status and actor id.)
- order-cancel-state-java: "이력 저장 실패 시 상태 변경과 이력 불일치 없음" removed as a repeat of "상태 이력 저장 실패 시 주문 상태 변경 롤백" (merge: Both block order_status_history inserts, request PAID→SHIPPED on a PAID order, and check that the order is not left SHIPPED without a matching history row.)
- plan-proration-aligned: "청구 성공 후 플랜 저장 실패 시 청구·플랜 불일치 없음" removed as a repeat of "과금 성공 후 플랜 변경 저장 실패 시 상태" (merge: Both inject a subscription save failure right after a successful mid-cycle Basic→Pro upgrade charge, then check that no state persists where the charge stands and the plan stays Basic; only the dates and amounts differ.)

## Compared with the last kept round

Compared with round 0 (the last one kept):

| Metric                             | Round 0 | Round 1 |        |
| ---------------------------------- | ------- | ------- | ------ |
| Overall                            | 1.70    | 1.82    | better |
| Must-cover (judge)                 | 98%     | 100%    | better |
| 2nd-order recall                   | 86%     | 82%     | worse  |
| Req. with a case                   | 100%    | 100%    | same   |
| Style viol./100                    | 0.0     | 0.0     | same   |
| Cases/spec (context)               | 53.6    | 39.2    | worse  |
| Merged away (context)              | 18      | 7       | —      |
| Actionability (0–2) (context)      | 1.77    | 1.80    | better |
| Traceability (0–2) (context)       | 1.75    | 1.85    | better |
| Priority (0–2) (context)           | 1.91    | 1.94    | better |
| Easy-to-miss value (0–2) (context) | 1.64    | 1.70    | better |
| QA-sheet style (0–2) (context)     | 1.99    | 2.00    | better |
| Spec coverage (0–2) (context)      | 2.00    | 2.00    | same   |
| No duplicates (0–2) (context)      | 1.00    | 1.36    | better |
| Honesty (0–2) (context)            | 1.79    | 2.00    | better |

Rows marked "context" do not affect the recommendation.

Recommendation for round 1: REVERT. A deterministic metric got worse: 2nd-order recall. Record the decision with plan --round 1 --decision keep|revert.
