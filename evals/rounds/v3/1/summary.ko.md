# Round 1 (v3 plan)

- Date: 2026-11-13
- Prompt: `2026-11-13.2`
- Change: prompt 2026-11-13.2: one intent one case, open outcomes as questions, merge with reasons
- Split: selected
- Language: ko
- Rubric judge: claude-sonnet-5-5, rubric v3.1
- Must-cover checked by: coverage judge (any language)
- Style violations counted by: lintCaseStyle
- Decision: keep
- Scored again on 2026-11-13: rubric judge (rubric v3.1) and deterministic metrics. The sheets are the ones written on the date above.

## Run

| Variant                | Specs | Errors | Overall | Case | Sheet | Spec coverage | Cases/spec | Must-cover (kw) | Must-cover (judge) | Req. with a case | Style viol./100 | Repeated titles | Merged away | Cost  | Judge cost |
| ---------------------- | ----- | ------ | ------- | ---- | ----- | ------------- | ---------- | --------------- | ------------------ | ---------------- | --------------- | --------------- | ----------- | ----- | ---------- |
| claude-opus-5-5 · high | 14    | 0      | 1.64    | 1.83 | 1.45  | 1.43          | 39.2       | 56%             | 100%               | 100%             | 0.0             | 0               | 7           | $7.42 | $0.86      |

| Criterion          | Mean (0–2) |
| ------------------ | ---------- |
| Actionability      | 1.77       |
| Traceability       | 1.80       |
| Priority           | 1.92       |
| Easy-to-miss value | 1.66       |
| QA-sheet style     | 1.98       |
| Spec coverage      | 1.43       |
| No duplicates      | 1.07       |
| Honesty            | 1.86       |

## Per spec

| Spec                         | Cases | P0  | Overall | Spec coverage | Must-cover (kw) | Must-cover (judge) | Reqs without a case | Style viol. | Merged away | Cost  |
| ---------------------------- | ----- | --- | ------- | ------------- | --------------- | ------------------ | ------------------- | ----------- | ----------- | ----- |
| api-rate-limit-aligned       | 39    | 12  | 1.41    | 1             | 80%             | 100%               | —                   | 0           | 1           | $0.66 |
| booking-hold-aligned         | 29    | 6   | 1.78    | 2             | 25%             | 100%               | —                   | 0           | 0           | $0.37 |
| contact-import-js            | 34    | 8   | 1.52    | 1             | 40%             | 100%               | —                   | 0           | 0           | $0.43 |
| coupon-expiry-missing        | 45    | 18  | 1.56    | 1             | 50%             | 100%               | —                   | 0           | 0           | $0.63 |
| notice-schedule-ko-narrative | 43    | 9   | 1.52    | 1             | 100%            | 100%               | —                   | 0           | 0           | $0.40 |
| order-cancel-state-java      | 38    | 21  | 1.52    | 1             | 83%             | 100%               | —                   | 0           | 5           | $0.61 |
| payroll-rules-mapreduce      | 52    | 10  | 1.43    | 1             | 67%             | 100%               | —                   | 0           | 0           | $0.89 |
| plan-proration-aligned       | 50    | 11  | 1.53    | 1             | 20%             | 100%               | —                   | 0           | 1           | $0.97 |
| profile-injection            | 34    | 4   | 1.94    | 2             | 0%              | 100%               | —                   | 0           | 0           | $0.34 |
| rbac-export-role             | 32    | 8   | 1.83    | 2             | 100%            | 100%               | —                   | 0           | 0           | $0.38 |
| search-page-cap              | 43    | 6   | 1.78    | 2             | 25%             | 100%               | —                   | 0           | 0           | $0.49 |
| seat-picker-aligned          | 39    | 9   | 1.77    | 2             | 40%             | 100%               | —                   | 0           | 0           | $0.51 |
| session-expiry-ko-ts         | 38    | 9   | 1.58    | 1             | 100%            | 100%               | —                   | 0           | 0           | $0.48 |
| stock-reserve-go             | 33    | 12  | 1.76    | 2             | 40%             | 100%               | —                   | 0           | 0           | $0.26 |

## What the rubric judge found missing

- api-rate-limit-aligned: AC2 / invalid_input: Retry-After header format is a whole integer, not decimal
- api-rate-limit-aligned: AC1 / boundary: 429 header presence on other response bodies and 429 body format
- booking-hold-aligned: AC3 / boundary: 5 seats rejected: only in index; open on error code
- booking-hold-aligned: AC1 / failure and timeout: retry after ErrSeatTaken or response lost on successful hold
- contact-import-js: AC2 / boundary: invalid skipped row list at 10,000 rows is covered; no case on very long email length limit
- contact-import-js: AC3 / permission: role without import permission uploading a file
- coupon-expiry-missing: AC1 / state_transition: Per-user redemption limit when the same coupon is sent to multiple accounts or an order is refunded after use (partially covered by C21)
- coupon-expiry-missing: AC2 / equivalence: Coupon with 0% or negative rate / cart total below any discount
- notice-schedule-ko-narrative: AC3 / data_integrity: Resend or retry action after failure is not covered; the spec says the admin decides to resend
- notice-schedule-ko-narrative: AC2 / boundary: Hidden cancel button state near cutoff on UI
- order-cancel-state-java: AC2 / state_transition: Cancel with SHIPPED and DELIVERED returns 409 body checks per status (C06 only in index)
- order-cancel-state-java: AC4 / invalid_input: Actor id missing or null on status change
- payroll-rules-mapreduce: AC2 / boundary: exactly 06:00 end and 22:00 start inclusion with a shift starting at 06:00 or ending at 22:00 as open question
- payroll-rules-mapreduce: AC3 / boundary: holiday spanning midnight, shift crossing into or out of a holiday
- payroll-rules-mapreduce: Rounding / equivalence: rounding applied per line vs total, multiple lines summed
- plan-proration-aligned: AC2 / data_integrity: downgrade leaves no refund and no credit in payment history
- plan-proration-aligned: AC4 / idempotency: repeated upgrade retry after PAYMENT_FAILED charges once
- profile-injection: AC1 / state_transition: Edit then cancel or leave screen: unsaved name not persisted
- rbac-export-role: AC3 / idempotency: counter state after 403-denied or failed exports (partially present)
- rbac-export-role: AC2 / data_integrity: audit entry fields persisted exactly (timestamp, immutability)
- seat-picker-aligned: AC1 / boundary: Select at 6 then deselect and reselect counted limit (covered); 0 seats vs. 1 seat count is covered; no gap
- seat-picker-aligned: AC2 / locale and time: Hold expiry timing while the user is on the screen
- session-expiry-ko-ts: AC3 / failure: 로그아웃 시 세션 저장소 장애 상태 처리
- session-expiry-ko-ts: AC1 / idempotency: 401 후 동일 만료 토큰 반복 요청 시 응답 동일
- stock-reserve-go: AC2 / concurrency: Multiple reservations expiring together restoring stock correctly

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
| Overall                            | 1.51    | 1.64    | better |
| Must-cover (judge)                 | 98%     | 100%    | better |
| Req. with a case                   | 100%    | 100%    | same   |
| Style viol./100                    | 0.0     | 0.0     | same   |
| Cases/spec (context)               | 53.6    | 39.2    | worse  |
| Merged away (context)              | 18      | 7       | —      |
| Actionability (0–2) (context)      | 1.73    | 1.77    | better |
| Traceability (0–2) (context)       | 1.69    | 1.80    | better |
| Priority (0–2) (context)           | 1.91    | 1.92    | better |
| Easy-to-miss value (0–2) (context) | 1.58    | 1.66    | better |
| QA-sheet style (0–2) (context)     | 1.98    | 1.98    | worse  |
| Spec coverage (0–2) (context)      | 1.43    | 1.43    | same   |
| No duplicates (0–2) (context)      | 0.64    | 1.07    | better |
| Honesty (0–2) (context)            | 1.50    | 1.86    | better |

Rows marked "context" do not affect the recommendation.

Recommendation for round 1: KEEP. The overall rose and no deterministic metric got worse. Record the decision with plan --round 1 --decision keep|revert.
