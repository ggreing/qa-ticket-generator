import type { AuthoredCase } from './build';

export const refundWebhookKoPy: AuthoredCase = {
  id: 'refund-webhook-ko-py',
  pr: {
    number: 2003,
    title: '결제사 환불 웹훅 수신 처리',
    author: 'seoyeon',
    headRef: 'feat/refund-webhook',
    body: `
관련 티켓: https://acme.atlassian.net/browse/PAY-311

결제사가 보내는 refund.completed 웹훅을 받아 환불 내역을 기록합니다.
서명 검증과 event_id 기준 중복 처리 방지를 넣었고, 환불 상세는 결제사 API로 다시 조회합니다.
`,
  },
  prd: [
    {
      source: 'jira',
      id: 'PAY-311',
      url: 'https://acme.atlassian.net/browse/PAY-311',
      title: '결제사 환불 웹훅 처리',
      acceptanceCriteria: [
        'AC1: X-Pay-Signature 헤더의 HMAC-SHA256 서명 검증에 실패하면 401을 반환하고 아무것도 기록하지 않는다.',
        'AC2: 같은 event_id의 웹훅이 다시 오면 200을 반환하되 환불을 다시 처리하지 않는다.',
        'AC3: 결제사 환불 조회 API가 5초 안에 응답하지 않으면 최대 3번까지 재시도하고, 그래도 실패하면 환불 상태를 FAILED로 기록한다.',
        'AC4: 부분 환불 금액의 합이 원결제 금액을 넘으면 해당 환불을 거절하고 REFUND_EXCEEDS_PAYMENT 오류를 기록한다.',
      ],
      body: `
## 배경
고객센터에서 결제사 관리자 화면으로 환불하면 우리 주문 데이터에는 반영되지 않는다.
결제사 웹훅을 받아 환불 내역을 자동으로 맞춘다.

## 인수 조건
- AC1: X-Pay-Signature 헤더의 HMAC-SHA256 서명 검증에 실패하면 401을 반환하고 아무것도 기록하지 않는다.
- AC2: 같은 event_id의 웹훅이 다시 오면 200을 반환하되 환불을 다시 처리하지 않는다.
- AC3: 결제사 환불 조회 API가 5초 안에 응답하지 않으면 최대 3번까지 재시도하고, 그래도 실패하면 환불 상태를 FAILED로 기록한다.
- AC4: 부분 환불 금액의 합이 원결제 금액을 넘으면 해당 환불을 거절하고 REFUND_EXCEEDS_PAYMENT 오류를 기록한다.

## 참고
결제사는 2xx 응답을 받지 못하면 같은 이벤트를 최대 24시간 동안 다시 보낸다.
`,
    },
  ],
  files: [
    {
      path: 'payments/webhooks.py',
      content: `
import hashlib
import hmac

from payments.errors import RefundRejected
from payments.refunds import RefundService


class RefundWebhook:
    """Handles refund.completed events from the payment provider."""

    def __init__(self, secret: bytes, refunds: RefundService, events):
        self._secret = secret
        self._refunds = refunds
        self._events = events

    def handle(self, headers: dict, raw_body: bytes, payload: dict):
        signature = headers.get("X-Pay-Signature", "")
        expected = hmac.new(self._secret, raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return 401, {"error": "invalid signature"}

        event_id = payload["event_id"]
        if not self._events.mark_seen(event_id):
            return 200, {"status": "duplicate"}

        try:
            self._refunds.record(payload["payment_id"], payload["refund_id"])
        except RefundRejected as e:
            return 200, {"status": "rejected", "error": e.code}
        return 200, {"status": "ok"}
`,
    },
    {
      path: 'payments/refunds.py',
      diff: `
-from payments.errors import PaymentNotFound
+from payments.errors import PaymentNotFound, RefundRejected
+from payments.gateway import GatewayClient


 class RefundService:
-    def __init__(self, payments):
+    def __init__(self, payments, gateway: GatewayClient):
         self._payments = payments
+        self._gateway = gateway

     def refunded_total(self, payment_id: str) -> int:
         return sum(r.amount for r in self._payments.refunds_of(payment_id))
+
+    def record(self, payment_id: str, refund_id: str) -> None:
+        payment = self._payments.get(payment_id)
+        if payment is None:
+            raise PaymentNotFound(payment_id)
+        refund = self._gateway.get_refund(refund_id)
+        if self.refunded_total(payment_id) + refund.amount > payment.amount:
+            self._payments.log_error(payment_id, "REFUND_EXCEEDS_PAYMENT")
+            raise RefundRejected("REFUND_EXCEEDS_PAYMENT")
+        self._payments.add_refund(payment_id, refund_id, refund.amount, status="COMPLETED")
`,
    },
    {
      path: 'payments/gateway.py',
      diff: `
 from dataclasses import dataclass

 import requests


 @dataclass
 class GatewayRefund:
     refund_id: str
     amount: int


 class GatewayClient:
     def __init__(self, base_url: str, api_key: str):
         self._base_url = base_url
         self._session = requests.Session()
         self._session.headers["Authorization"] = "Bearer " + api_key

     def get_payment(self, payment_id: str) -> dict:
         resp = self._session.get(f"{self._base_url}/payments/{payment_id}", timeout=10)
         resp.raise_for_status()
         return resp.json()
+
+    def get_refund(self, refund_id: str) -> GatewayRefund:
+        resp = self._session.get(f"{self._base_url}/refunds/{refund_id}")
+        resp.raise_for_status()
+        body = resp.json()
+        return GatewayRefund(refund_id=body["id"], amount=body["amount"])
`,
    },
  ],
  expected: {
    expectedAlignment: 'partial',
    mustFindings: [
      {
        id: 'AC1',
        requirement: '서명 검증 실패 시 401, 기록 없음',
        labels: ['AC1'],
        keywords: ['X-Pay-Signature', 'HMAC-SHA256'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: '같은 event_id 재전송은 200, 재처리 없음',
        labels: ['AC2'],
        keywords: ['event_id'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: '조회 API 5초 타임아웃, 최대 3회 재시도, 실패 시 FAILED',
        labels: ['AC3'],
        keywords: ['5초 안에', '3번까지 재시도'],
        accept: ['missing'],
      },
      {
        id: 'AC4',
        requirement: '부분 환불 합계가 원결제 초과 시 거절',
        labels: ['AC4'],
        keywords: ['REFUND_EXCEEDS_PAYMENT', '부분 환불'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'gateway-timeout',
        risk: 'The refund lookup API does not answer within 5 seconds: it must be retried up to 3 times and then the refund recorded as FAILED (today there is no timeout and no retry)',
        keywords: [
          ['timeout', 'time out', 'timed out', '5 second', '5s', '5초', '타임아웃', 'retry', '재시도'],
        ],
      },
      {
        id: 'bad-signature',
        risk: 'A webhook with a wrong or missing X-Pay-Signature gets 401 and nothing is recorded',
        keywords: [
          ['signature', '서명'],
          ['401', 'reject', 'invalid', '거절'],
        ],
      },
      {
        id: 'duplicate-event',
        risk: 'The same event_id delivered twice returns 200 the second time and records the refund only once',
        keywords: [['event_id', 'duplicate', 'same event', 'twice', 'redeliver', '중복', '재전송']],
      },
      {
        id: 'over-refund-boundary',
        risk: 'Partial refunds summing exactly to the payment amount are accepted; one unit more is rejected with REFUND_EXCEEDS_PAYMENT',
        keywords: [['refund_exceeds_payment', 'exceed', 'over-refund', 'more than the payment', '초과']],
      },
      {
        id: 'concurrent-duplicates',
        risk: 'Two deliveries of the same event arrive at the same time: only one refund row is written',
        keywords: [['concurren', 'parallel', 'simultaneous', 'at the same time', 'race', '동시']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Chargebacks and refund e-mails to customers are in neither the ticket nor the code',
        patterns: ['chargeback', 'refund email', 'refund e-mail'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['payments', 'python', 'korean', 'external-failure', 'missing'],
    notes:
      'Korean PRD. AC3 (5s timeout, 3 retries, FAILED status) is absent: get_refund has no timeout and no retry, and a failure surfaces as an exception.',
  },
};
