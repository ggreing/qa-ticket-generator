import type { AuthoredCase } from './build';

export const sessionExpiryKoTs: AuthoredCase = {
  id: 'session-expiry-ko-ts',
  pr: {
    number: 2004,
    title: '세션 유휴 만료와 로그아웃 정리',
    author: 'minjun',
    headRef: 'feat/session-expiry',
    body: `
Closes #1904

세션 저장소에 마지막 사용 시각과 절대 만료 시각을 두고, 인증 미들웨어에서 둘 다 검사합니다.
로그아웃 API도 새로 추가했습니다.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#1904',
      url: 'https://github.com/acme/shop/issues/1904',
      title: '세션 만료 정책 적용',
      acceptanceCriteria: [
        'AC1: 마지막 요청 후 30분 동안 요청이 없으면 세션이 만료되고, 만료된 세션으로 요청하면 401을 반환한다.',
        'AC2: 활동 여부와 상관없이 로그인 후 12시간이 지나면 세션이 만료된다.',
        'AC3: 로그아웃하면 해당 사용자의 모든 기기 세션이 함께 무효화된다.',
      ],
      body: `
보안 점검에서 세션이 무기한 유지된다는 지적을 받았다.

### 인수 조건
- AC1: 마지막 요청 후 30분 동안 요청이 없으면 세션이 만료되고, 만료된 세션으로 요청하면 401을 반환한다.
- AC2: 활동 여부와 상관없이 로그인 후 12시간이 지나면 세션이 만료된다.
- AC3: 로그아웃하면 해당 사용자의 모든 기기 세션이 함께 무효화된다.

공용 PC에서 로그아웃한 뒤 휴대폰에 남은 세션이 계속 살아 있던 신고가 있었다.
`,
    },
  ],
  files: [
    {
      path: 'src/auth/session-store.ts',
      diff: `
+import { settings } from '../config/settings';
+
+export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
+
 export interface Session {
   id: string;
   userId: string;
   createdAt: number;
+  lastSeenAt: number;
+  absoluteExpiresAt: number;
 }

 export interface SessionStore {
   get(id: string): Promise<Session | null>;
   put(session: Session): Promise<void>;
+  delete(id: string): Promise<void>;
 }

-export function newSession(id: string, userId: string, now: number): Session {
-  return { id, userId, createdAt: now };
+export function newSession(id: string, userId: string, now: number): Session {
+  return {
+    id,
+    userId,
+    createdAt: now,
+    lastSeenAt: now,
+    absoluteExpiresAt: now + settings.sessionAbsoluteTtlMs,
+  };
 }
+
+/** True when the session has been idle too long or has passed its absolute lifetime. */
+export function isExpired(session: Session, now: number): boolean {
+  return now - session.lastSeenAt > IDLE_TIMEOUT_MS || now >= session.absoluteExpiresAt;
+}
`,
    },
    {
      path: 'src/auth/middleware.ts',
      diff: `
-import type { SessionStore } from './session-store';
+import { isExpired, type SessionStore } from './session-store';

 export function requireSession(store: SessionStore, clock: () => number) {
   return async (req: Request & { sessionId?: string; userId?: string }) => {
     const session = req.sessionId ? await store.get(req.sessionId) : null;
     if (!session) return new Response('unauthorized', { status: 401 });
+    const now = clock();
+    if (isExpired(session, now)) {
+      await store.delete(session.id);
+      return new Response('session expired', { status: 401 });
+    }
+    await store.put({ ...session, lastSeenAt: now });
     req.userId = session.userId;
     return null;
   };
 }
`,
    },
    {
      path: 'src/auth/logout.ts',
      content: `
import type { SessionStore } from './session-store';

export function logoutHandler(store: SessionStore) {
  return async (req: Request & { sessionId?: string }) => {
    if (req.sessionId) await store.delete(req.sessionId);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' } });
  };
}
`,
    },
  ],
  expected: {
    expectedAlignment: 'partial',
    mustFindings: [
      {
        id: 'AC1',
        requirement: '30분 유휴 시 만료, 만료 세션은 401',
        labels: ['AC1'],
        keywords: ['30분'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: '로그인 후 12시간 절대 만료',
        labels: ['AC2'],
        keywords: ['12시간'],
        accept: ['unclear'],
      },
      {
        id: 'AC3',
        requirement: '로그아웃 시 모든 기기 세션 무효화',
        labels: ['AC3'],
        keywords: ['모든 기기'],
        accept: ['missing'],
      },
    ],
    mustScenarios: [
      {
        id: 'idle-boundary',
        risk: 'A request after 29 minutes of idleness passes; one after 31 minutes gets 401 and the session is deleted',
        keywords: [
          ['30 min', '30분', 'thirty', '31', 'idle', '유휴'],
          ['401', 'expire', '만료'],
        ],
      },
      {
        id: 'sliding',
        risk: 'Steady activity keeps the idle timer sliding (each request updates lastSeenAt) but cannot extend the absolute lifetime',
        keywords: [['lastseen', 'last seen', 'sliding', 'extend', 'activity', 'refresh', '활동', '연장']],
      },
      {
        id: 'absolute-12h',
        risk: 'A session that is used continuously still expires 12 hours after login; the actual TTL value comes from settings not shown in the PR',
        keywords: [['12 hour', '12h', '12-hour', '12시간', 'absolute', '절대']],
      },
      {
        id: 'logout-all-devices',
        risk: 'Logging out on one device must also invalidate the same user’s sessions on other devices; only the current session is deleted today',
        keywords: [['device', 'other session', 'all session', 'every session', '기기', '모든 세션']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Remember-me cookies and MFA re-prompts appear in neither the issue nor the code',
        patterns: ['remember me', 'remember-me', 'mfa'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['auth', 'typescript', 'korean', 'unclear', 'missing'],
    notes:
      'Korean PRD. AC2 is unclear on purpose: the absolute lifetime comes from settings.sessionAbsoluteTtlMs, whose value is outside the PR. AC3 is absent: logout deletes only the current session.',
  },
};
