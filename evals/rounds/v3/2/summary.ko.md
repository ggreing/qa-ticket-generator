# Round 2 (v3 plan)

- Date: 2026-11-16
- Prompt: `2026-11-16.1`
- Change: prompt 2026-11-16.1: seven questions a requirement does not ask for (who else, zero/same, per what, across the line, and then, other thing's state, what comes back)
- Split: selected
- Language: ko
- Rubric judge: claude-sonnet-5-5, rubric v3.1
- Must-cover checked by: coverage judge (any language)
- Style violations counted by: lintCaseStyle
- Decision: pending

## Run

| Variant                | Specs | Errors | Overall | Case | Sheet | Spec coverage | Cases/spec | Must-cover (kw) | Must-cover (judge) | Req. with a case | Style viol./100 | Repeated titles | Merged away | Cost  | Judge cost |
| ---------------------- | ----- | ------ | ------- | ---- | ----- | ------------- | ---------- | --------------- | ------------------ | ---------------- | --------------- | --------------- | ----------- | ----- | ---------- |
| claude-opus-5-5 · high | 14    | 0      | 1.60    | 1.81 | 1.39  | 1.43          | 42.8       | 61%             | 100%               | 100%             | 0.0             | 0               | 5           | $8.37 | $0.86      |

| Criterion          | Mean (0–2) |
| ------------------ | ---------- |
| Actionability      | 1.71       |
| Traceability       | 1.77       |
| Priority           | 1.92       |
| Easy-to-miss value | 1.65       |
| QA-sheet style     | 1.99       |
| Spec coverage      | 1.43       |
| No duplicates      | 0.86       |
| Honesty            | 1.86       |

## Per spec

| Spec                         | Cases | P0  | Overall | Spec coverage | Must-cover (kw) | Must-cover (judge) | Reqs without a case | Style viol. | Merged away | Cost  |
| ---------------------------- | ----- | --- | ------- | ------------- | --------------- | ------------------ | ------------------- | ----------- | ----------- | ----- |
| api-rate-limit-aligned       | 45    | 13  | 1.28    | 1             | 80%             | 100%               | —                   | 0           | 0           | $0.73 |
| booking-hold-aligned         | 30    | 9   | 1.38    | 1             | 25%             | 100%               | —                   | 0           | 0           | $0.54 |
| contact-import-js            | 41    | 12  | 1.80    | 2             | 40%             | 100%               | —                   | 0           | 0           | $0.46 |
| coupon-expiry-missing        | 53    | 14  | 1.56    | 1             | 100%            | 100%               | —                   | 0           | 0           | $0.70 |
| notice-schedule-ko-narrative | 44    | 8   | 1.52    | 1             | 100%            | 100%               | —                   | 0           | 0           | $0.49 |
| order-cancel-state-java      | 41    | 24  | 1.42    | 1             | 83%             | 100%               | —                   | 0           | 4           | $0.66 |
| payroll-rules-mapreduce      | 56    | 11  | 1.53    | 1             | 33%             | 100%               | —                   | 0           | 0           | $1.03 |
| plan-proration-aligned       | 52    | 17  | 1.48    | 1             | 20%             | 100%               | —                   | 0           | 1           | $0.97 |
| profile-injection            | 40    | 4   | 1.80    | 2             | 67%             | 100%               | —                   | 0           | 0           | $0.39 |
| rbac-export-role             | 35    | 8   | 1.81    | 2             | 75%             | 100%               | —                   | 0           | 0           | $0.42 |
| search-page-cap              | 41    | 8   | 1.53    | 1             | 25%             | 100%               | —                   | 0           | 0           | $0.54 |
| seat-picker-aligned          | 46    | 10  | 1.77    | 2             | 60%             | 100%               | —                   | 0           | 0           | $0.59 |
| session-expiry-ko-ts         | 42    | 9   | 1.77    | 2             | 100%            | 100%               | —                   | 0           | 0           | $0.51 |
| stock-reserve-go             | 33    | 14  | 1.78    | 2             | 60%             | 100%               | —                   | 0           | 0           | $0.35 |

## What the rubric judge found missing

- api-rate-limit-aligned: AC2 / boundary: Retry-After rounding at exact whole-second remaining (value 1, last second) and 0 case
- api-rate-limit-aligned: AC1 / boundary: Request exactly at 60.0s: included or excluded in window is open question
- booking-hold-aligned: AC3 / boundary: Hold request of 3 seats (just under limit) or same customer holding more across requests is covered; missing: 4+1 seats where one is already held by self
- booking-hold-aligned: AC1 / idempotency: Retried identical request by same customer after network timeout (response)
- contact-import-js: AC2 / data_integrity: Line number of skipped row when a quoted field spans lines or after blank lines
- coupon-expiry-missing: AC3 / permission: expired coupon at payment submit when applied earlier is covered; none for already-used AND expired priority
- coupon-expiry-missing: AC2 / locale_time: currency or locale amount display of cap
- notice-schedule-ko-narrative: AC3 / permission: Alert goes only to the reserving admin, not other users
- notice-schedule-ko-narrative: AC3 / state_transition: Retry after failure actually sends notice (see C31 exists but unseen)
- order-cancel-state-java: AC3 / failure: partial refund by gateway or refund declined, status outcome
- order-cancel-state-java: AC2 / state_transition: cancel of PAID order concurrent with refund already issued manually
- payroll-rules-mapreduce: Rounding / boundary: exact half-cent rounds up on a single pay line (x.xx5)
- payroll-rules-mapreduce: AC1 / boundary: threshold hours counting per week with unpaid breaks or partial minutes at 40h inclusion
- payroll-rules-mapreduce: AC2 / equivalence: night premium on holiday hours (2x plus 50%?)
- plan-proration-aligned: AC1 / boundary: Rounding below half cent rounds down
- plan-proration-aligned: AC2 / failure: Renewal charge failure after downgrade
- profile-injection: AC2 / permission: notification content/recipient when old address equals unverified; no verification of new address (spec silent)
- profile-injection: AC1 / equivalence: non-Korean/mixed-script names counted by characters (partly in C33 only)
- rbac-export-role: AC3 / permission: limit applied to non-admin 403 vs 429 precedence
- search-page-cap: AC4 / boundary: Result count exactly a multiple of limit: last full page cursor and following empty page
- seat-picker-aligned: AC1 / boundary: Selecting exactly 6 then the error message wording/exact text on 7th is covered; no gap
- session-expiry-ko-ts: AC1 / permission: 타 사용자 만료 세션 토큰으로 접근 시 401
- session-expiry-ko-ts: AC3 / idempotency: 이미 로그아웃된 세션으로 로그아웃 재요청
- stock-reserve-go: AC3 / invalid_input: quantity non-integer/missing has C29 listed; fine
- stock-reserve-go: AC1 / permission: none applicable

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
| Overall                            | 1.64    | 1.60    | worse  |
| Must-cover (judge)                 | 100%    | 100%    | same   |
| Req. with a case                   | 100%    | 100%    | same   |
| Style viol./100                    | 0.0     | 0.0     | same   |
| Cases/spec (context)               | 39.2    | 42.8    | better |
| Merged away (context)              | 7       | 5       | —      |
| Actionability (0–2) (context)      | 1.77    | 1.71    | worse  |
| Traceability (0–2) (context)       | 1.80    | 1.77    | worse  |
| Priority (0–2) (context)           | 1.92    | 1.92    | worse  |
| Easy-to-miss value (0–2) (context) | 1.66    | 1.65    | worse  |
| QA-sheet style (0–2) (context)     | 1.98    | 1.99    | better |
| Spec coverage (0–2) (context)      | 1.43    | 1.43    | same   |
| No duplicates (0–2) (context)      | 1.07    | 0.86    | worse  |
| Honesty (0–2) (context)            | 1.86    | 1.86    | same   |

Rows marked "context" do not affect the recommendation.

Recommendation for round 2: REVERT. The overall did not rise. Record the decision with plan --round 2 --decision keep|revert.
