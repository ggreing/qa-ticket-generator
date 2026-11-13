# Round 0 (v3 plan)

- Date: 2026-11-13
- Prompt: `2026-11-13.1`
- Change: baseline: plan prompt 2026-11-13.1
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
| claude-opus-5-5 · high | 14    | 0      | 1.51    | 1.78 | 1.25  | 1.43          | 53.6       | 64%             | 98%                | 100%             | 0.0             | 0               | 18          | $7.11 | $0.90      |

| Criterion          | Mean (0–2) |
| ------------------ | ---------- |
| Actionability      | 1.73       |
| Traceability       | 1.69       |
| Priority           | 1.91       |
| Easy-to-miss value | 1.58       |
| QA-sheet style     | 1.98       |
| Spec coverage      | 1.43       |
| No duplicates      | 0.64       |
| Honesty            | 1.50       |

## Per spec

| Spec                         | Cases | P0  | Overall | Spec coverage | Must-cover (kw) | Must-cover (judge) | Reqs without a case | Style viol. | Merged away | Cost  |
| ---------------------------- | ----- | --- | ------- | ------------- | --------------- | ------------------ | ------------------- | ----------- | ----------- | ----- |
| api-rate-limit-aligned       | 52    | 12  | 1.24    | 1             | 80%             | 100%               | —                   | 0           | 0           | $0.56 |
| booking-hold-aligned         | 40    | 11  | 1.63    | 2             | 25%             | 100%               | —                   | 0           | 0           | $0.38 |
| contact-import-js            | 48    | 10  | 1.51    | 1             | 60%             | 80%                | —                   | 0           | 0           | $0.40 |
| coupon-expiry-missing        | 62    | 15  | 1.44    | 1             | 75%             | 100%               | —                   | 0           | 1           | $0.59 |
| notice-schedule-ko-narrative | 51    | 9   | 1.36    | 1             | 100%            | 100%               | —                   | 0           | 0           | $0.39 |
| order-cancel-state-java      | 63    | 27  | 1.26    | 1             | 83%             | 100%               | —                   | 0           | 8           | $0.65 |
| payroll-rules-mapreduce      | 64    | 16  | 1.56    | 1             | 50%             | 100%               | —                   | 0           | 2           | $0.91 |
| plan-proration-aligned       | 71    | 19  | 1.17    | 1             | 40%             | 100%               | —                   | 0           | 4           | $0.91 |
| profile-injection            | 50    | 7   | 1.76    | 2             | 33%             | 100%               | —                   | 0           | 0           | $0.29 |
| rbac-export-role             | 44    | 16  | 1.80    | 2             | 75%             | 100%               | —                   | 0           | 0           | $0.26 |
| search-page-cap              | 49    | 10  | 1.65    | 2             | 25%             | 100%               | —                   | 0           | 3           | $0.49 |
| seat-picker-aligned          | 57    | 19  | 1.76    | 2             | 80%             | 100%               | —                   | 0           | 0           | $0.48 |
| session-expiry-ko-ts         | 54    | 13  | 1.67    | 2             | 100%            | 100%               | —                   | 0           | 0           | $0.47 |
| stock-reserve-go             | 45    | 15  | 1.40    | 1             | 60%             | 100%               | —                   | 0           | 0           | $0.32 |

## Must-cover risks with no case

- contact-import-js: csv-quoting

## What the rubric judge found missing

- api-rate-limit-aligned: AC1 / permission: revoked or disabled key behavior and its counter
- api-rate-limit-aligned: AC2 / data_integrity: 429 response status/body format and Retry-After for 429 vs other headers
- booking-hold-aligned: AC2 / idempotency: payment completion after hold already expired and seat untouched
- contact-import-js: AC3 / state_transition: Existing contact in a state like deleted/archived matched by import
- contact-import-js: AC2 / data_integrity: Skipped rows listed when result list is exported/reopened later
- coupon-expiry-missing: AC2 / boundary: maxDiscount = 0 or percentage 0%
- coupon-expiry-missing: AC1 / permission: coupon code of another user (targeted e-mail coupon) used by different account
- notice-schedule-ko-narrative: AC2 / boundary: 1 minute before send: boundary included or not, no flag raised
- notice-schedule-ko-narrative: AC3 / state_transition: resend of a failed notice, which the spec leaves open
- notice-schedule-ko-narrative: AC1 / boundary: maximum or far-future schedule time
- order-cancel-state-java: AC3 / boundary: partial refund or already partially refunded order
- order-cancel-state-java: AC2 / state_transition: cancel of PAID order moves to CANCELLED: is PAID→CANCELLED allowed by AC1 chain
- payroll-rules-mapreduce: AC2 / boundary: night premium window start 22:00 start inclusion with work beginning exactly 22:00
- payroll-rules-mapreduce: AC3 / permission: who may set public holidays
- plan-proration-aligned: AC2 / boundary: downgrade on renewal date itself, as a spec-defined boundary of the cycle
- plan-proration-aligned: AC1 / invalid_input: downgrade to a higher or equal price plan
- plan-proration-aligned: AC1 / equivalence: upgrade with negative or zero price difference
- profile-injection: AC2 / failure/timeout: Mail service slow or timing out affecting save response
- profile-injection: AC3 / boundary: Bio 159 characters just below limit
- rbac-export-role: AC3 / boundary: limit counted per user across roles other than admin is moot; but whether a non-admin 403 attempts count toward the limit
- search-page-cap: AC3 / permission: none applicable
- seat-picker-aligned: AC1 / boundary: unselecting then reselecting at limit 6 vs 7 across showtime already covered; seat map row adjacency none
- session-expiry-ko-ts: AC3 / permission: 타 사용자 세션 ID로 로그아웃 시도
- stock-reserve-go: AC2 / boundary: Exactly 15:00 release case exists only as C23; confirm at exactly 15:00 not covered separately
- stock-reserve-go: AC2 / permission: Confirm/release of another user's reservation

## Cases the merge step removed

Check that each one really repeats the case it was folded into.

- coupon-expiry-missing: "존재하지 않는 쿠폰 코드 입력 시 적용 불가" removed as a repeat of "존재하지 않는 쿠폰 코드 입력 시 만료 에러 미노출" (merge)
- order-cancel-state-java: "존재하지 않는 주문 취소 시 HTTP 404" removed as a repeat of "존재하지 않는 주문 취소 시 환불 미발생" (merge)
- order-cancel-state-java: "비로그인 상태 주문 취소 요청 HTTP 401" removed as a repeat of "미인증 취소 요청 시 401 응답 및 환불 없음" (merge)
- order-cancel-state-java: "타 고객 주문 취소 요청 거부" removed as a repeat of "타 고객의 PAID 주문 취소 요청 거부 및 환불 없음" (merge)
- order-cancel-state-java: "PAID 취소 중 환불 게이트웨이 실패 시 상태 유지" removed as a repeat of "게이트웨이 장애 시 취소 실패 및 PAID 유지" (merge)
- order-cancel-state-java: "PAID 주문 취소와 SHIPPED 전이 동시 요청" removed as a repeat of "취소와 출고 처리 동시 발생 시 환불·출고 중복 없음" (merge)
- order-cancel-state-java: "IllegalStatusTransition 거부 시 이력 미기록" removed as a repeat of "거부된 전이 order_status_history 미기록" (merge)
- order-cancel-state-java: "PENDING 주문 취소 시 PENDING → 취소 이력 기록" removed as a repeat of "취소 성공 시 이력 PENDING→CANCELLED와 actor id 기록" (merge)
- order-cancel-state-java: "PENDING 주문 취소 시 CANCELLED 전이 허용" removed as a repeat of "PENDING 주문 취소 시 CANCELLED 상태 반영" (merge)
- payroll-rules-mapreduce: "공휴일 8시간 포함 주 48시간 시 초과 미발생" removed as a repeat of "평일 40시간+공휴일 8시간 주 연장근로 0시간" (merge)
- payroll-rules-mapreduce: "공휴일 야간근무 2배 위에 야간가산 추가" removed as a repeat of "공휴일 야간 근무 시 2배와 야간 할증 중첩 계산" (merge)
- plan-proration-aligned: "갱신일 당일 업그레이드 시 새 주기 기준 청구" removed as a repeat of "갱신일 당일 업그레이드 시 새 주기 기준 청구" (exact)
- plan-proration-aligned: "청구 성공 후 플랜 변경 저장 실패 시 청구 취소" removed as a repeat of "결제 승인 후 플랜 저장 실패 시 청구만 남지 않음" (merge)
- plan-proration-aligned: "타인 구독 ID로 업그레이드 요청 시 거부" removed as a repeat of "타 사용자 구독 업그레이드 요청 시 거부 및 미청구" (merge)
- plan-proration-aligned: "존재하지 않는 플랜 ID 변경 요청 시 거부" removed as a repeat of "존재하지 않는 플랜 ID 업그레이드 시 미청구" (merge)
- search-page-cap: "페이지 조회 사이 신상품 등록 시 2페이지 중복 없음" removed as a repeat of "1페이지 조회 후 신규 상품 등록 시 2페이지 중복 없음" (merge)
- search-page-cap: "기본 크기로 전체 순회 시 합계와 일치 상품 수 동일" removed as a repeat of "전체 페이지 순회 시 결과 합계와 매칭 건수 일치" (merge)
- search-page-cap: "일치 상품 21건일 때 기본 크기 2페이지 1건 반환" removed as a repeat of "전체 건수 limit+1 시 마지막 페이지 1건과 빈 cursor" (merge)

## Compared with the last kept round

No recommendation for round 0: Round 0 is the baseline. Mark it with plan --round 0 --decision keep so later rounds are compared with it.
