# Round 1 (v3 plan)

- Date: 2026-11-13
- Prompt: `2026-11-13.2`
- Change: prompt 2026-11-13.2: one intent one case, open outcomes as questions, merge with reasons
- Split: selected
- Language: ko
- Rubric judge: claude-sonnet-5-5, rubric v3
- Must-cover checked by: coverage judge (any language)
- Style violations counted by: lintCaseStyle
- Decision: pending

## Run

| Variant                | Specs | Errors | Overall | Case | Sheet | Spec coverage | Cases/spec | Must-cover (kw) | Must-cover (judge) | Req. with a case | Style viol./100 | Repeated titles | Merged away | Cost  | Judge cost |
| ---------------------- | ----- | ------ | ------- | ---- | ----- | ------------- | ---------- | --------------- | ------------------ | ---------------- | --------------- | --------------- | ----------- | ----- | ---------- |
| claude-opus-5-5 · high | 14    | 0      | 1.60    | 1.81 | 1.39  | 1.43          | 39.2       | 56%             | 100%               | 100%             | 0.0             | 0               | 7           | $7.42 | $0.85      |

| Criterion          | Mean (0–2) |
| ------------------ | ---------- |
| Actionability      | 1.73       |
| Traceability       | 1.78       |
| Priority           | 1.93       |
| Easy-to-miss value | 1.65       |
| QA-sheet style     | 1.99       |
| Spec coverage      | 1.43       |
| No duplicates      | 0.86       |
| Honesty            | 1.86       |

## Per spec

| Spec                         | Cases | P0  | Overall | Spec coverage | Must-cover (kw) | Must-cover (judge) | Reqs without a case | Style viol. | Merged away | Cost  |
| ---------------------------- | ----- | --- | ------- | ------------- | --------------- | ------------------ | ------------------- | ----------- | ----------- | ----- |
| api-rate-limit-aligned       | 39    | 12  | 1.65    | 2             | 80%             | 100%               | —                   | 0           | 1           | $0.66 |
| booking-hold-aligned         | 29    | 6   | 1.66    | 2             | 25%             | 100%               | —                   | 0           | 0           | $0.37 |
| contact-import-js            | 34    | 8   | 1.52    | 1             | 40%             | 100%               | —                   | 0           | 0           | $0.43 |
| coupon-expiry-missing        | 45    | 18  | 1.58    | 1             | 50%             | 100%               | —                   | 0           | 0           | $0.63 |
| notice-schedule-ko-narrative | 43    | 9   | 1.77    | 2             | 100%            | 100%               | —                   | 0           | 0           | $0.40 |
| order-cancel-state-java      | 38    | 21  | 1.66    | 2             | 83%             | 100%               | —                   | 0           | 5           | $0.61 |
| payroll-rules-mapreduce      | 52    | 10  | 1.76    | 2             | 67%             | 100%               | —                   | 0           | 0           | $0.89 |
| plan-proration-aligned       | 50    | 11  | 1.52    | 1             | 20%             | 100%               | —                   | 0           | 1           | $0.97 |
| profile-injection            | 34    | 4   | 1.53    | 1             | 0%              | 100%               | —                   | 0           | 0           | $0.34 |
| rbac-export-role             | 32    | 8   | 1.56    | 1             | 100%            | 100%               | —                   | 0           | 0           | $0.38 |
| search-page-cap              | 43    | 6   | 1.79    | 2             | 25%             | 100%               | —                   | 0           | 0           | $0.49 |
| seat-picker-aligned          | 39    | 9   | 1.42    | 1             | 40%             | 100%               | —                   | 0           | 0           | $0.51 |
| session-expiry-ko-ts         | 38    | 9   | 1.55    | 1             | 100%            | 100%               | —                   | 0           | 0           | $0.48 |
| stock-reserve-go             | 33    | 12  | 1.50    | 1             | 40%             | 100%               | —                   | 0           | 0           | $0.26 |

## What the rubric judge found missing

- api-rate-limit-aligned: AC2 / invalid_input: 429 response body/header format on other endpoints
- booking-hold-aligned: AC3 / boundary: 5 seats rejected with specific error (C21 only in index; likely covered) and 4 seats with one conflict
- booking-hold-aligned: AC1 / state_transition: hold released by cancel/payment failure not specified
- contact-import-js: AC3 / concurrency: Two simultaneous imports updating the same existing contact
- contact-import-js: AC1 / boundary: Very large file size/performance near the limit
- coupon-expiry-missing: AC1 / permission: Another user's coupon code, or one bound to a different user
- coupon-expiry-missing: AC2 / equivalence: Percentage coupon on a cart with zero or very small total
- coupon-expiry-missing: AC4 / idempotency: Promotion becomes inactive and cart re-evaluated
- notice-schedule-ko-narrative: AC3 / happy_path: The failure notice reaches the scheduling admin (content and channel)
- order-cancel-state-java: AC2 / state_transition: Cancel response for SHIPPED vs DELIVERED separately, cancel of already-cancelled order status code
- order-cancel-state-java: AC4 / data_integrity: History row actor id for a CS cancel in the DB
- payroll-rules-mapreduce: AC3 / boundary: holiday spanning midnight into a normal day
- payroll-rules-mapreduce: AC3 / equivalence: holiday plus night premium at 22:00-06:00 expected amount
- plan-proration-aligned: AC2 / failure: Renewal charge failure when applying a scheduled downgrade
- plan-proration-aligned: AC1 / boundary: Upgrade to a plan with equal price (zero difference)
- profile-injection: AC2 / equivalence: Change to an e-mail already used by another account
- rbac-export-role: AC2 / data_integrity: Log row count and actor id match actual file rows
- rbac-export-role: AC3 / state_transition: Rate-limit counter resets and 429 response format/Retry-After
- seat-picker-aligned: AC1 / locale: limit message language in non-English locales
- seat-picker-aligned: AC3 / boundary: rapid repeated showtime changes (A to B to A)
- session-expiry-ko-ts: AC1 / permission: 401 body/response for other endpoints and logout with expired session
- session-expiry-ko-ts: AC2 / concurrency: multiple devices with different login times each hit 12h separately
- stock-reserve-go: AC3 / boundary: Quantity 10 and 11 against stock below 10 (error precedence)
- stock-reserve-go: AC2 / permission: Who may confirm or release a reservation (other user's reservation)

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
| Overall                            | 1.54    | 1.60    | better |
| Must-cover (judge)                 | 98%     | 100%    | better |
| Req. with a case                   | 100%    | 100%    | same   |
| Style viol./100                    | 0.0     | 0.0     | same   |
| Cases/spec (context)               | 53.6    | 39.2    | worse  |
| Merged away (context)              | 18      | 7       | —      |
| Actionability (0–2) (context)      | 1.73    | 1.73    | better |
| Traceability (0–2) (context)       | 1.74    | 1.78    | better |
| Priority (0–2) (context)           | 1.92    | 1.93    | better |
| Easy-to-miss value (0–2) (context) | 1.61    | 1.65    | better |
| QA-sheet style (0–2) (context)     | 1.98    | 1.99    | better |
| Spec coverage (0–2) (context)      | 1.57    | 1.43    | worse  |
| No duplicates (0–2) (context)      | 0.57    | 0.86    | better |
| Honesty (0–2) (context)            | 1.43    | 1.86    | better |

Rows marked "context" do not affect the recommendation.

Recommendation for round 1: KEEP. The overall rose and no deterministic metric got worse. Record the decision with plan --round 1 --decision keep|revert.
