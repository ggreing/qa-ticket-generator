import type { AuthoredCase } from './build';

export const webhookDeliveryNoPrd: AuthoredCase = {
  id: 'webhook-delivery-no-prd',
  pr: {
    number: 2012,
    title: 'Retry and sign outgoing merchant webhooks',
    author: 'felix',
    headRef: 'feat/webhook-retries',
    body: `
Merchants keep missing order events when their endpoint has a hiccup. Deliveries are now signed
and retried with backoff; events that never get through land in the dead-letter table so support
can replay them by hand. We agreed on this in the platform sync, there is no written spec.
`,
  },
  prd: [],
  files: [
    {
      path: 'src/webhooks/sign.ts',
      content: `
import { createHmac } from 'node:crypto';

/** Hex HMAC-SHA256 over "<timestamp>.<body>", sent as x-acme-signature: t=<timestamp>,v1=<hex>. */
export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(\`\${timestamp}.\${body}\`).digest('hex');
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return \`t=\${timestamp},v1=\${sign(secret, timestamp, body)}\`;
}
`,
    },
    {
      path: 'src/webhooks/deliver.ts',
      content: `
import { signatureHeader } from './sign';

export const MAX_ATTEMPTS = 5;
/** Wait before attempt 2, 3, 4 and 5. */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RETRY_AFTER_MS = 60_000;

export interface Endpoint {
  id: string;
  url: string;
  secret: string;
}

export interface WebhookEvent {
  id: string;
  type: string;
  data: unknown;
}

export type DeliveryOutcome =
  | { status: 'delivered'; attempts: number }
  | { status: 'dead'; attempts: number; lastError: string };

export interface DeliverDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export async function deliver(endpoint: Endpoint, event: WebhookEvent, deps: DeliverDeps): Promise<DeliveryOutcome> {
  const body = JSON.stringify(event);
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timestamp = Math.floor(deps.now() / 1000);
    let waitMs = BACKOFF_MS[attempt - 1] ?? 0;
    try {
      const res = await deps.fetch(endpoint.url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-acme-event-id': event.id,
          'x-acme-signature': signatureHeader(endpoint.secret, timestamp, body),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return { status: 'delivered', attempts: attempt };
      lastError = \`HTTP \${res.status}\`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        // The receiver rejected the event itself; sending it again will not help.
        return { status: 'dead', attempts: attempt, lastError };
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
      }
    } catch (err) {
      lastError = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error';
    }
    if (attempt < MAX_ATTEMPTS) await deps.sleep(waitMs);
  }
  return { status: 'dead', attempts: MAX_ATTEMPTS, lastError };
}
`,
    },
    {
      path: 'src/webhooks/queue.ts',
      diff: `
-import type { Endpoint, WebhookEvent } from './types';
+import { deliver, type DeliverDeps, type Endpoint, type WebhookEvent } from './deliver';

 export interface DeadLetterStore {
   add(entry: { eventId: string; endpointId: string; lastError: string; attempts: number }): Promise<void>;
 }

 export class WebhookWorker {
   constructor(
     private readonly endpoints: { forEvent(type: string): Promise<Endpoint[]> },
     private readonly deadLetters: DeadLetterStore,
-    private readonly post: (url: string, body: string) => Promise<void>,
+    private readonly deps: DeliverDeps,
   ) {}

   async handle(event: WebhookEvent): Promise<void> {
     for (const endpoint of await this.endpoints.forEvent(event.type)) {
-      await this.post(endpoint.url, JSON.stringify(event));
+      const outcome = await deliver(endpoint, event, this.deps);
+      if (outcome.status === 'dead') {
+        await this.deadLetters.add({
+          eventId: event.id,
+          endpointId: endpoint.id,
+          lastError: outcome.lastError,
+          attempts: outcome.attempts,
+        });
+      }
     }
   }
 }
`,
    },
  ],
  expected: {
    expectedAlignment: 'no_prd',
    mustFindings: [],
    mustScenarios: [
      {
        id: 'retry-schedule',
        risk: 'A 503 or network error is retried after 1, 2, 4 and 8 seconds; after the 5th failed attempt the event goes to the dead-letter table',
        keywords: [
          ['retr', 'backoff', 'back-off', 'attempt'],
          ['5th', 'fifth', 'five', '5 attempts', 'dead'],
        ],
      },
      {
        id: 'no-retry-4xx',
        risk: 'A 400 or 404 response is not retried: the event goes straight to dead letters after one attempt',
        keywords: [
          ['400', '404', '4xx', 'client error'],
          ['retr', 'dead', 'one attempt', 'single attempt', 'immediately'],
        ],
      },
      {
        id: 'retry-after-429',
        risk: '429 with Retry-After waits that many seconds before the next attempt, capped at 60 seconds',
        keywords: [['429', 'retry-after', 'retry after', 'rate limit']],
      },
      {
        id: 'timeout',
        risk: 'An endpoint that does not answer within 10 seconds counts as a failed attempt and is retried',
        keywords: [['timeout', 'time out', 'timed out', '10 s', '10-second', '10 second', 'slow']],
      },
      {
        id: 'signature',
        risk: 'Each attempt carries x-acme-signature t=<timestamp>,v1=<HMAC-SHA256 of timestamp.body>, recomputed with a fresh timestamp',
        keywords: [['signature', 'hmac', 'sign']],
      },
      {
        id: 'multi-endpoint',
        risk: 'One endpoint failing does not stop or delay delivery to the other endpoints subscribed to the same event (deliveries run one after another today)',
        keywords: [['endpoint'], ['other', 'another', 'second', 'multiple', 'several', 'each']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'There is no PRD; replay APIs and endpoint auto-disabling are not in the code either',
        patterns: ['replay api', 'replay endpoint', 'auto-disable', 'automatically disable'],
        fields: ['scenarios'],
      },
    ],
    tags: ['webhooks', 'typescript', 'external-failure', 'no_prd'],
    notes: 'No PRD is linked. Alignment must be no_prd with no findings; scenarios come from the code alone.',
  },
};
