import type { AuthoredCase } from './build';

export const notificationRetryAligned: AuthoredCase = {
  id: 'notification-retry-aligned',
  pr: {
    number: 733,
    title: 'Retry failed notification deliveries',
    author: 'sofia',
    headRef: 'feat/notification-retries',
    body: `
Closes #330

sendWithRetry() replaces the single-shot send. The sleep function is injected so the
worker can pass its own timer.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#330',
      url: 'https://github.com/acme/shop/issues/330',
      title: 'Order notifications get lost when the provider hiccups',
      acceptanceCriteria: [
        'AC1: A failed delivery is retried up to 3 times, waiting 1s, 2s and 4s before the retries.',
        'AC2: Responses with a 4xx status are not retried, except 429.',
        'AC3: Every attempt for one notification sends the same Idempotency-Key header, so a retry cannot create a duplicate.',
      ],
      body: `
About 0.4% of order confirmations never arrive because the provider answers 503 for a few
seconds during their deploys.

### Acceptance Criteria
- AC1: A failed delivery is retried up to 3 times, waiting 1s, 2s and 4s before the retries.
- AC2: Responses with a 4xx status are not retried, except 429.
- AC3: Every attempt for one notification sends the same Idempotency-Key header, so a retry cannot create a duplicate.

Network errors (no response at all) count as failed deliveries.
`,
    },
  ],
  files: [
    {
      path: 'src/notifications/sender.ts',
      diff: `
 import type { Notification, ProviderClient } from './provider-client';

+const RETRY_DELAYS_MS = [1000, 2000, 4000];
+
 export interface SendResult {
   delivered: boolean;
+  attempts: number;
   status?: number;
 }

-export async function send(client: ProviderClient, notification: Notification): Promise<SendResult> {
-  const response = await client.post('/v1/messages', notification.payload, {});
-  return { delivered: response.status < 400, status: response.status };
+export type Sleep = (ms: number) => Promise<void>;
+
+function isRetryable(status: number | undefined): boolean {
+  // No status means the request never got a response (network error).
+  return status === undefined || status === 429 || status >= 500;
+}
+
+export async function sendWithRetry(
+  client: ProviderClient,
+  notification: Notification,
+  sleep: Sleep,
+): Promise<SendResult> {
+  const headers = { 'Idempotency-Key': notification.id };
+  for (let attempt = 0; ; attempt++) {
+    let status: number | undefined;
+    try {
+      status = (await client.post('/v1/messages', notification.payload, headers)).status;
+    } catch {
+      status = undefined;
+    }
+    if (status !== undefined && status < 400) {
+      return { delivered: true, attempts: attempt + 1, status };
+    }
+    const delay = RETRY_DELAYS_MS[attempt];
+    if (!isRetryable(status) || delay === undefined) {
+      return { delivered: false, attempts: attempt + 1, status };
+    }
+    await sleep(delay);
+  }
 }
`,
    },
    {
      path: 'src/notifications/worker.ts',
      diff: `
 import { setTimeout as sleep } from 'node:timers/promises';
 import type { NotificationQueue } from './queue';
 import type { ProviderClient } from './provider-client';
-import { send } from './sender';
+import { sendWithRetry } from './sender';

 export async function drain(queue: NotificationQueue, client: ProviderClient): Promise<void> {
   for await (const notification of queue) {
-    const result = await send(client, notification);
+    const result = await sendWithRetry(client, notification, (ms) => sleep(ms));
     await queue.ack(notification.id, result.delivered);
   }
 }
`,
    },
  ],
  expected: {
    expectedAlignment: 'aligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Up to 3 retries with 1s, 2s, 4s delays',
        labels: ['AC1'],
        keywords: ['up to 3 times', '1s, 2s and 4s'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: '4xx not retried except 429',
        labels: ['AC2'],
        keywords: ['4xx', 'except 429'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: 'Same Idempotency-Key on every attempt',
        labels: ['AC3'],
        keywords: ['Idempotency-Key'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'exhausted',
        risk: 'The provider keeps failing: after the third retry (four attempts) delivery is reported as failed',
        keywords: [
          [
            'fourth',
            '4th',
            'four attempts',
            '4 attempts',
            'third retry',
            '3 retries',
            'three retries',
            'exhaust',
            'gives up',
            'give up',
          ],
        ],
      },
      {
        id: 'no-retry-4xx',
        risk: 'A 400/404-style client error is not retried',
        keywords: [['400', '404', '422', '403', '401', '4xx']],
      },
      { id: 'retry-429', risk: 'A 429 response is retried', keywords: [['429']] },
      {
        id: 'idempotency',
        risk: 'All attempts of one notification carry the same Idempotency-Key',
        keywords: [['idempotency']],
      },
      {
        id: 'network-error',
        risk: 'A request that throws (no response) is treated as a failed delivery and retried',
        keywords: [['network', 'throws', 'no response', 'timeout', 'connection']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Dead-letter queues, jitter and circuit breakers are in neither the issue nor the code',
        patterns: ['dead-letter', 'dead letter', 'circuit breaker', 'jitter'],
        fields: ['findings'],
      },
    ],
    tags: ['retry', 'typescript', 'aligned'],
    notes:
      'Everything is implemented. A report that marks a requirement missing or contradicted is wrong here.',
  },
};
