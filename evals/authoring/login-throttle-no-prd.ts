import type { AuthoredCase } from './build';

export const loginThrottleNoPrd: AuthoredCase = {
  id: 'login-throttle-no-prd',
  pr: {
    number: 918,
    title: 'Throttle repeated failed logins',
    author: 'kofi',
    headRef: 'feat/login-throttle',
    body: `
We saw credential stuffing against the login form last week. This locks an account name
for a while after repeated failures. No ticket yet, I will file one after review.
`,
  },
  prd: [],
  files: [
    {
      path: 'auth/throttle.py',
      content: `
MAX_FAILED_ATTEMPTS = 5
WINDOW_SECONDS = 10 * 60
LOCKOUT_SECONDS = 15 * 60


class LoginThrottle:
    """Counts failed logins per username in a key-value store with expiring keys."""

    def __init__(self, store):
        self._store = store

    def is_locked(self, username: str) -> bool:
        return self._store.exists(self._lock_key(username))

    def record_failure(self, username: str) -> None:
        count = self._store.incr(self._count_key(username), ttl=WINDOW_SECONDS)
        if count >= MAX_FAILED_ATTEMPTS:
            self._store.set(self._lock_key(username), "1", ttl=LOCKOUT_SECONDS)
            self._store.delete(self._count_key(username))

    def record_success(self, username: str) -> None:
        self._store.delete(self._count_key(username))

    @staticmethod
    def _count_key(username: str) -> str:
        return "login:failures:" + username.strip().lower()

    @staticmethod
    def _lock_key(username: str) -> str:
        return "login:locked:" + username.strip().lower()
`,
    },
    {
      path: 'auth/login.py',
      diff: `
 from auth.passwords import verify_password
-from auth.errors import InvalidCredentials
+from auth.errors import AccountLocked, InvalidCredentials


-def login(username: str, password: str, users, sessions):
+def login(username: str, password: str, users, sessions, throttle):
+    if throttle.is_locked(username):
+        raise AccountLocked()
+
     user = users.find_by_username(username)
     if user is None or not verify_password(password, user.password_hash):
+        throttle.record_failure(username)
         raise InvalidCredentials()
+
+    throttle.record_success(username)
     return sessions.create(user.id)
`,
    },
  ],
  expected: {
    expectedAlignment: 'no_prd',
    mustFindings: [],
    mustScenarios: [
      {
        id: 'lock-after-five',
        risk: 'The fifth failed login locks the username; the next attempt is refused even with the right password',
        keywords: [
          ['5 failed', '5 consecutive', '5 times', '5 wrong', '5 incorrect', 'five', 'fifth', '5th'],
          ['lock'],
        ],
      },
      {
        id: 'lock-expires',
        risk: 'The lock lifts after 15 minutes',
        keywords: [['15 min', '15-min', 'fifteen', '900', 'lockout_seconds'], ['lock']],
      },
      {
        id: 'success-resets',
        risk: 'A successful login clears the failure counter',
        keywords: [['success'], ['reset', 'clear', 'counter', 'count']],
      },
      {
        id: 'window',
        risk: 'Failures spread over more than the 10 minute window do not add up to a lock',
        keywords: [['10 min', '10-min', 'ten min', 'window', '600']],
      },
      {
        id: 'unknown-user',
        risk: 'Failed logins for a username that does not exist are counted too, so the response does not reveal which usernames exist',
        keywords: [['unknown', 'non-existent', 'nonexistent', 'does not exist', 'not exist', 'enumerat']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'CAPTCHA, per-IP limits and e-mail alerts are not in the code and there is no PRD',
        patterns: ['captcha', 'email alert', 'e-mail alert', 'notification email'],
        fields: ['scenarios'],
      },
    ],
    tags: ['auth', 'python', 'no_prd'],
    notes: 'No PRD is linked. Alignment must be no_prd with no findings; scenarios come from the code alone.',
  },
};
