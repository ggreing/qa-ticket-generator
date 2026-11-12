import type { AuthoredCase } from './build';

export const apiRateLimitAligned: AuthoredCase = {
  id: 'api-rate-limit-aligned',
  pr: {
    number: 2007,
    title: 'Per-key rate limit for the public API',
    author: 'tomas',
    headRef: 'feat/api-rate-limit',
    body: `
Jira: https://acme.atlassian.net/browse/API-42

Sliding-window limiter keyed by API key, wired in as middleware in front of every /v1 route.
Each key has its own lock, so different keys never wait on each other.
`,
  },
  prd: [
    {
      source: 'jira',
      id: 'API-42',
      url: 'https://acme.atlassian.net/browse/API-42',
      title: 'Rate limit the public API per key',
      acceptanceCriteria: [
        'AC1: Each API key may make at most 100 requests in any rolling 60-second window.',
        'AC2: A request over the limit gets HTTP 429 with a Retry-After header holding the whole seconds until the oldest counted request leaves the window, rounded up.',
        'AC3: Limits are counted per API key; one key reaching its limit does not slow down or block other keys.',
        'AC4: The limit holds under concurrency: 150 parallel requests with one key produce exactly 100 successes.',
      ],
      body: `
## Context
One integration partner sent 40k requests in a minute and degraded the API for everyone.

## Acceptance Criteria
- AC1: Each API key may make at most 100 requests in any rolling 60-second window.
- AC2: A request over the limit gets HTTP 429 with a Retry-After header holding the whole seconds until the oldest counted request leaves the window, rounded up.
- AC3: Limits are counted per API key; one key reaching its limit does not slow down or block other keys.
- AC4: The limit holds under concurrency: 150 parallel requests with one key produce exactly 100 successes.
`,
    },
  ],
  files: [
    {
      path: 'internal/ratelimit/limiter.go',
      content: `
package ratelimit

import (
	"math"
	"sync"
	"time"
)

// Limiter allows at most Limit requests per key in any rolling Window.
type Limiter struct {
	Limit  int
	Window time.Duration
	now    func() time.Time

	mu   sync.Mutex
	keys map[string]*keyLog
}

type keyLog struct {
	mu    sync.Mutex
	times []time.Time // accepted request times, oldest first
}

func New(limit int, window time.Duration, now func() time.Time) *Limiter {
	return &Limiter{Limit: limit, Window: window, now: now, keys: map[string]*keyLog{}}
}

func (l *Limiter) logFor(key string) *keyLog {
	l.mu.Lock()
	defer l.mu.Unlock()
	k, ok := l.keys[key]
	if !ok {
		k = &keyLog{}
		l.keys[key] = k
	}
	return k
}

// Allow records the request and returns true, or returns false and how long to wait.
func (l *Limiter) Allow(key string) (bool, int) {
	k := l.logFor(key)
	k.mu.Lock()
	defer k.mu.Unlock()

	now := l.now()
	cutoff := now.Add(-l.Window)
	drop := 0
	for drop < len(k.times) && !k.times[drop].After(cutoff) {
		drop++
	}
	k.times = k.times[drop:]

	if len(k.times) >= l.Limit {
		wait := k.times[0].Add(l.Window).Sub(now)
		secs := int(math.Ceil(wait.Seconds()))
		if secs < 1 {
			secs = 1
		}
		return false, secs
	}
	k.times = append(k.times, now)
	return true, 0
}
`,
    },
    {
      path: 'internal/ratelimit/middleware.go',
      content: `
package ratelimit

import (
	"net/http"
	"strconv"
)

// Middleware rejects requests over the per-key limit with 429 and Retry-After.
func Middleware(l *Limiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("X-Api-Key")
		if key == "" {
			http.Error(w, "missing api key", http.StatusUnauthorized)
			return
		}
		ok, retryAfter := l.Allow(key)
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
`,
    },
    {
      path: 'cmd/api/main.go',
      diff: `
 package main

 import (
 	"log"
 	"net/http"
+	"time"

 	"github.com/acme/shop/internal/api"
+	"github.com/acme/shop/internal/ratelimit"
 )

 func main() {
 	mux := http.NewServeMux()
 	api.Register(mux)
-	log.Fatal(http.ListenAndServe(":8080", mux))
+	limiter := ratelimit.New(100, 60*time.Second, time.Now)
+	log.Fatal(http.ListenAndServe(":8080", ratelimit.Middleware(limiter, mux)))
 }
`,
    },
  ],
  expected: {
    expectedAlignment: 'aligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'At most 100 requests per rolling 60 seconds per key',
        labels: ['AC1'],
        keywords: ['100 requests', 'rolling 60-second'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: '429 with Retry-After rounded up',
        labels: ['AC2'],
        keywords: ['Retry-After', 'HTTP 429'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: 'Limits independent per key',
        labels: ['AC3'],
        keywords: ['other keys'],
        accept: ['covered'],
      },
      {
        id: 'AC4',
        requirement: 'Exactly 100 of 150 parallel requests succeed',
        labels: ['AC4'],
        keywords: ['150 parallel', 'exactly 100'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'hundred-first',
        risk: 'The 100th request inside 60 seconds succeeds and the 101st gets 429',
        keywords: [
          ['101', '100th', 'over the limit', 'exceed'],
          ['429', 'reject', 'too many'],
        ],
      },
      {
        id: 'retry-after',
        risk: 'Retry-After holds the whole seconds until the oldest request leaves the window, rounded up (e.g. 12.3 s left → 13)',
        keywords: [['retry-after', 'retry after']],
      },
      {
        id: 'window-slides',
        risk: 'Once the oldest request is more than 60 seconds old a new request is allowed again (rolling, not fixed-minute, window)',
        keywords: [['60 s', '60-second', '60 second', 'sliding', 'rolling', 'window']],
      },
      {
        id: 'other-key',
        risk: 'A second key keeps working while the first key is limited',
        keywords: [
          ['another key', 'other key', 'second key', 'different key', 'per key', 'per-key', 'key b'],
        ],
      },
      {
        id: 'parallel',
        risk: '150 parallel requests with one key yield exactly 100 successes and 50 responses with 429',
        keywords: [['parallel', 'concurren', 'simultaneous', '150']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Paid plan tiers and IP-based limits are in neither the ticket nor the code',
        patterns: ['paid tier', 'premium tier', 'per-ip limit', 'ip-based limit'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['api', 'go', 'concurrency', 'aligned'],
    notes: 'Fully implemented: a per-key sliding log with a per-key mutex; Retry-After is rounded up.',
  },
};
