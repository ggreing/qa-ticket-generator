# Round 3 (v3 plan)

- Date: 2026-11-16
- Prompt: `2026-11-16.3`
- Change: prompt 2026-11-16.3: seven questions once per action/value/period, merge pass for every sheet
- Split: selected
- Language: ko
- Rubric judge: claude-sonnet-5-5, rubric v3.2
- Must-cover checked by: coverage judge (any language)
- Style violations counted by: lintCaseStyle
- Decision: pending

## Run

| Variant                | Specs | Errors | Overall | Case | Sheet | Spec coverage | Cases/spec | Must-cover (kw) | Must-cover (judge) | 2nd-order recall | Req. with a case | Style viol./100 | Repeated titles | Merged away | Cost  | Judge cost |
| ---------------------- | ----- | ------ | ------- | ---- | ----- | ------------- | ---------- | --------------- | ------------------ | ---------------- | ---------------- | --------------- | --------------- | ----------- | ----- | ---------- |
| claude-opus-5-5 · high | 14    | 0      | 1.81    | 1.86 | 1.76  | 2.00          | 37.9       | 56%             | 98%                | 93%              | 100%             | 0.2             | 0               | 7           | $7.84 | $0.99      |

| Criterion          | Mean (0–2) |
| ------------------ | ---------- |
| Actionability      | 1.86       |
| Traceability       | 1.85       |
| Priority           | 1.94       |
| Easy-to-miss value | 1.67       |
| QA-sheet style     | 2.00       |
| Spec coverage      | 2.00       |
| No duplicates      | 1.36       |
| Honesty            | 1.93       |

## Per spec

| Spec                         | Cases | P0  | Overall | Spec coverage | Must-cover (kw) | Must-cover (judge) | 2nd-order | Reqs without a case | Style viol. | Merged away | Cost  |
| ---------------------------- | ----- | --- | ------- | ------------- | --------------- | ------------------ | --------- | ------------------- | ----------- | ----------- | ----- |
| api-rate-limit-aligned       | 36    | 11  | 1.76    | 2             | 80%             | 100%               | 6/6       | —                   | 0           | 1           | $0.60 |
| booking-hold-aligned         | 27    | 9   | 1.93    | 2             | 25%             | 100%               | 7/7       | —                   | 0           | 0           | $0.48 |
| contact-import-js            | 32    | 9   | 1.76    | 2             | 40%             | 80%                | 6/7       | —                   | 0           | 0           | $0.48 |
| coupon-expiry-missing        | 40    | 16  | 1.94    | 2             | 75%             | 100%               | 7/7       | —                   | 0           | 0           | $0.63 |
| notice-schedule-ko-narrative | 43    | 6   | 1.94    | 2             | 100%            | 100%               | 6/7       | —                   | 0           | 0           | $0.43 |
| order-cancel-state-java      | 38    | 22  | 1.60    | 2             | 83%             | 100%               | 5/7       | —                   | 0           | 3           | $0.64 |
| payroll-rules-mapreduce      | 50    | 8   | 1.75    | 2             | 50%             | 100%               | 8/8       | —                   | 0           | 0           | $0.96 |
| plan-proration-aligned       | 52    | 15  | 1.76    | 2             | 20%             | 100%               | 7/7       | —                   | 0           | 1           | $0.93 |
| profile-injection            | 40    | 6   | 1.78    | 2             | 0%              | 100%               | 7/7       | —                   | 0           | 0           | $0.44 |
| rbac-export-role             | 27    | 9   | 1.79    | 2             | 75%             | 100%               | 7/7       | —                   | 0           | 0           | $0.39 |
| search-page-cap              | 40    | 7   | 1.76    | 2             | 25%             | 100%               | 8/8       | —                   | 0           | 1           | $0.49 |
| seat-picker-aligned          | 38    | 9   | 1.94    | 2             | 40%             | 100%               | 4/5       | —                   | 0           | 0           | $0.52 |
| session-expiry-ko-ts         | 34    | 9   | 1.73    | 2             | 100%            | 100%               | 7/7       | —                   | 0           | 1           | $0.51 |
| stock-reserve-go             | 33    | 12  | 1.94    | 2             | 60%             | 100%               | 4/6       | —                   | 1           | 0           | $0.35 |

## Must-cover risks with no case

- contact-import-js: csv-quoting

## Second-order combinations with no case

From the fixed list in `expected.secondOrder`. This list does not change between rounds.

- contact-import-js: deleted-contact-match
- notice-schedule-ko-narrative: reschedule-too-soon
- order-cancel-state-java: partially-refunded-order
- order-cancel-state-java: other-customers-order
- seat-picker-aligned: sold-out-showtime
- stock-reserve-go: other-users-reservation
- stock-reserve-go: confirm-twice

## Cases the merge step removed

Check that each one really repeats the case it was folded into.

- api-rate-limit-aligned: "서로 다른 엔드포인트 요청 키 단위 합산 100건" removed as a repeat of "엔드포인트·메서드 혼합 요청 키 단위 합산" (merge: Cases 9 and 27 both start with a fresh key, spread exactly 100 requests over several endpoints and then send one more. Both check that this request gets 429, because the limit is summed per key and not per endpoint. Case 9 also mixes HTTP methods.)
- order-cancel-state-java: "동일 PAID 주문 동시 취소 2건 시 환불 1회" removed as a repeat of "PAID 주문 동시 취소 2건 시 환불 1회" (merge: Both send two concurrent cancel requests for the same PAID order and check that the gateway refunds once for the full captured amount and that one cancel row is written to history; 11 also checks the final cancelled status.)
- order-cancel-state-java: "PENDING 주문 취소 시 게이트웨이 환불 미호출" removed as a repeat of "PENDING 주문 취소 시 환불 요청 미발생" (merge: Both cancel a PENDING order that has no capture and check that zero refund requests reach the gateway and that the order ends in the cancelled status.)
- order-cancel-state-java: "상태 변경 중 이력 저장 실패 시 상태·이력 불일치 없음" removed as a repeat of "이력 저장 실패 시 상태만 변경된 주문 없음" (merge: Both inject an order_status_history write failure during a PAID→SHIPPED transition and check that no order ends up SHIPPED without a matching history row.)
- plan-proration-aligned: "결제 대행사 응답 타임아웃 시 결제·요금제 불일치 없음" removed as a repeat of "결제 대행사 응답 타임아웃 시 결제·플랜 불일치 없음" (merge: Both start from a Basic subscriber upgrading to Pro while the payment gateway's response is delayed past the timeout, and both check only that an approved charge never coexists with Basic and that Pro never exists without an approved charge.)
- search-page-cap: "cursor 다음 페이지 요청 limit 미지정 시 20건" removed as a repeat of "기본 limit으로 전체 순회 시 누락·중복 없음" (merge: Both start from 45 products matching "셔츠" with limit omitted, follow the first page's next_cursor, and check that the second page has 20 results with no ids repeated from page 1. Case 17's full traversal (20, 20, 5 with all 45 ids unique) observes everything case 4 does.)
- session-expiry-ko-ts: "로그인 후 12시간 1초 요청 시 401" removed as a repeat of "지속 활동 중 로그인 12시간 경과 시 만료" (merge: Cases 16 and 19 share the same setup: user01 logs in at 09:00:00 and keeps making requests every 10 minutes. Both send a request at 21:00:01 and expect 401. Case 16 also checks that the 20:50:00 request returns 200.)

## Compared with the last kept round

Compared with round 1 (the last one kept):

| Metric                             | Round 1 | Round 3 |        |
| ---------------------------------- | ------- | ------- | ------ |
| Overall                            | 1.82    | 1.81    | worse  |
| Must-cover (judge)                 | 100%    | 98%     | worse  |
| 2nd-order recall                   | 82%     | 93%     | better |
| Req. with a case                   | 100%    | 100%    | same   |
| Style viol./100                    | 0.0     | 0.2     | worse  |
| Cases/spec (context)               | 39.2    | 37.9    | worse  |
| Merged away (context)              | 7       | 7       | —      |
| Actionability (0–2) (context)      | 1.80    | 1.86    | better |
| Traceability (0–2) (context)       | 1.85    | 1.85    | worse  |
| Priority (0–2) (context)           | 1.94    | 1.94    | worse  |
| Easy-to-miss value (0–2) (context) | 1.70    | 1.67    | worse  |
| QA-sheet style (0–2) (context)     | 2.00    | 2.00    | better |
| Spec coverage (0–2) (context)      | 2.00    | 2.00    | same   |
| No duplicates (0–2) (context)      | 1.36    | 1.36    | same   |
| Honesty (0–2) (context)            | 2.00    | 1.93    | worse  |

Rows marked "context" do not affect the recommendation.

Recommendation for round 3: REVERT. A deterministic metric got worse: must-cover (judge), style viol./100. Record the decision with plan --round 3 --decision keep|revert.
