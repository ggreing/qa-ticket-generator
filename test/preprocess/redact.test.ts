/** PRE-05 — one positive and one negative (look-alike) per rule. All secrets are FAKE. */
import { describe, expect, it } from 'vitest';
import {
  finalizeRedactions,
  isHighEntropySecret,
  marker,
  redactDiffBody,
  redactText,
  safeCut,
  secretKind,
  shannonEntropy,
} from '../../src/preprocess/redact';

function redact(text: string): { text: string; counts: Record<string, number> } {
  const counts = new Map<string, number>();
  const out = finalizeRedactions(redactText(text), counts);
  return { text: out, counts: Object.fromEntries(counts) };
}

const RULES: { rule: string; positive: string; negative: string }[] = [
  {
    rule: 'aws_access_key',
    positive: 'id = AKIAIOSFODNN7EXAMPLE',
    negative: 'id = AKIAIOSFODNN7EXAMP',
  },
  {
    rule: 'aws_secret_key',
    positive: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    negative: 'aws_region = eu-west-1',
  },
  {
    rule: 'github_token',
    positive: 'curl -H "token ghp_FAKE00000000000000000000000000000000"',
    negative: 'see ghp_ prefix docs',
  },
  {
    rule: 'github_token',
    positive: 'export X=github_pat_FAKE0000000000000000000_FAKE0000',
    negative: 'the github_pat_ prefix',
  },
  { rule: 'gitlab_token', positive: 'glpat-FAKE000000000000000000', negative: 'glpat-short' },
  { rule: 'slack_token', positive: 'xoxb-FAKE-0000-not-a-real-token', negative: 'xoxb-short' },
  { rule: 'slack_token', positive: 'xapp-1-AFAKE000-1234-fakefake', negative: 'xapp-1-' },
  {
    rule: 'slack_webhook',
    positive: 'https://hooks.slack.com/services/TFAKE/BFAKE/FAKEfake',
    negative: 'https://hooks.slack.com/',
  },
  { rule: 'stripe_key', positive: 'sk_live_FAKE00000000', negative: 'pk_live_FAKE00000000' },
  { rule: 'stripe_key', positive: 'whsec_FAKE0000000000000000', negative: 'whsec_short' },
  {
    rule: 'google_api_key',
    positive: `key AIza${'F'.repeat(35)}`,
    negative: `key AIza${'F'.repeat(30)}`,
  },
  {
    rule: 'private_key',
    positive: '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIFAKE\n-----END EC PRIVATE KEY-----',
    negative:
      '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFAKE\n-----END PUBLIC KEY-----',
  },
  {
    rule: 'jwt',
    positive: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.RkFLRS1zaWduYXR1cmU',
    negative: 'eyJhbGciOiJIUzI1NiJ9.notajwt.x',
  },
  { rule: 'url_password', positive: 'redis://app:FAKEpass1@cache:6379', negative: 'redis://cache:6379' },
  {
    rule: 'bearer_token',
    positive: 'Authorization: Bearer FAKE0000000000000000000000',
    negative: 'Bearer auth',
  },
  { rule: 'password', positive: 'password = "hunter2!x"', negative: 'password: string;' },
  { rule: 'password', positive: 'DB_PASSWORD=supersecret', negative: 'DB_PASSWORD=$DB_PASSWORD' },
  { rule: 'secret', positive: "client_secret: 's3cr3tvalue9'", negative: 'const secret = loadSecret();' },
  { rule: 'token', positive: 'authToken := "tok_12345678"', negative: 'const maxTokens = 4096;' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${...} placeholder is the point
  { rule: 'api_key', positive: '"apiKey": "abcd1234efgh"', negative: '"apiKey": "${API_KEY}"' },
  {
    rule: 'high_entropy',
    positive: 'const seed = "q8Zr4LmX2vPn7TbK9wYc3JdF";',
    negative: 'const sha = "3f2c9b1a7e4d8f60c2b5a9e1d7f3c8b6a4e2d0f9";',
  },
];

describe('PRE-05 redaction rules', () => {
  for (const { rule, positive, negative } of RULES) {
    it(`PRE-05 ${rule}: redacts "${positive.slice(0, 24)}…"`, () => {
      const r = redact(positive);
      expect(r.text).toContain(`[REDACTED:${rule}]`);
      expect(r.counts[rule]).toBeGreaterThanOrEqual(1);
    });
    it(`PRE-05 ${rule}: keeps look-alike "${negative.slice(0, 24)}…"`, () => {
      expect(redact(negative).text).toBe(negative);
    });
  }
});

describe('PRE-05 false-positive guards', () => {
  it.each([
    ['git SHA', 'revision = "3f2c9b1a7e4d8f60c2b5a9e1d7f3c8b6a4e2d0f9"'],
    ['sha256 hex', `digest = "${'ab12'.repeat(16)}"`],
    ['UUID', 'id = "123e4567-e89b-12d3-a456-426614174000"'],
    ['SRI hash', 'integrity: "sha512-q8Zr4LmX2vPn7TbK9wYc3JdFq8Zr4LmX2vPn7TbK9wYc3JdF"'],
    ['base64 PNG', 'logo = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"'],
    ['data URI', 'logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"'],
    ['file path', 'asset = "static/img/hero-banner-2x-retina.webp"'],
    ['prose', 'The nonce q8Zr4LmX2vPn7TbK9wYc3JdF is only mentioned here.'],
    ['camelCase identifier', 'handler = "someVeryLongCamelCaseHandlerName"'],
    ['TS type annotation', 'interface Login { password: string; token?: string }'],
    ['member access', 'const token = this.config?.auth.token;'],
    ['function call', 'password = os.environ.get("DB_PASSWORD")'],
    ['UI label', 'labels = { password: "Password", token: "Token" }'],
    ['sentence value', 'passwordHint: "Use at least 8 characters"'],
    ['template', 'token: "{{ .Values.token }}"'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${{ }} expression is the point
    ['GitHub Actions expression', 'token: ${{ secrets.TOKEN }}'],
    ['short value', 'pwd = "abc"'],
    ['numeric value', 'MAX_TOKEN=5'],
    ['comparison', 'if (token == "abc12345") {}'],
    ['publishable Stripe key', 'STRIPE_PK = "pk_test_FAKE0000"'],
  ])('PRE-05 keeps %s', (_label, text) => {
    expect(redact(text).text).toBe(text);
  });

  it('PRE-05 finds an assignment hidden behind a non-secret key (ticket: password = ...)', () => {
    expect(redact('see ticket: password = "hunter2!x"').text).toBe(
      'see ticket: password = "[REDACTED:password]"',
    );
  });

  it('PRE-05 handles Python-style annotated assignments', () => {
    expect(redact('api_key: str = "abcd1234efgh"').text).toBe('api_key: str = "[REDACTED:api_key]"');
  });
});

describe('PRE-05 mechanics', () => {
  it('PRE-05 preserves line structure of multi-line secrets', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\nafter';
    const out = redact(pem).text;
    expect(out.split('\n')).toHaveLength(5);
    expect(out.split('\n')[4]).toBe('after');
  });

  it('PRE-05 masks an unterminated PEM block up to the last base64 line', () => {
    const out = redact('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEFAKEFAKEFAKE\n\nFAKEFAKEFAKE\ncode();').text;
    expect(out).toBe('x\n[REDACTED:private_key]\n\n\n\ncode();');
  });

  it('PRE-05 redacts diff bodies without breaking +/-/space prefixes', () => {
    const body =
      ' ctx\n+-----BEGIN PRIVATE KEY-----\n+AAAA\n+-----END PRIVATE KEY-----\n-password = "hunter2!x"';
    const out = finalizeRedactions(redactDiffBody(body), new Map());
    expect(out).toBe(' ctx\n+[REDACTED:private_key]\n+\n+\n-password = "[REDACTED:password]"');
    expect(redactDiffBody('')).toBe('');
    expect(redactDiffBody(' clean\n+line')).toBe(' clean\n+line');
  });

  it('PRE-05 counts only markers that are finalized, one per occurrence', () => {
    const counts = new Map<string, number>();
    finalizeRedactions(redactText('a=AKIAIOSFODNN7EXAMPLE b=AKIAIOSFODNN7EXAMPLE'), counts);
    expect(counts.get('aws_access_key')).toBe(2);
    expect(finalizeRedactions('nothing here', counts)).toBe('nothing here');
  });

  it('PRE-05 text that already says [REDACTED:x] is not counted', () => {
    const counts = new Map<string, number>();
    expect(finalizeRedactions(redactText('literal [REDACTED:jwt] text'), counts)).toBe(
      'literal [REDACTED:jwt] text',
    );
    expect(counts.size).toBe(0);
  });

  it('PRE-05 neutralizes pre-existing marker characters so counts cannot be spoofed', () => {
    const spoof = `${marker('jwt')}`;
    const counts = new Map<string, number>();
    finalizeRedactions(redactText(spoof), counts);
    expect(counts.size).toBe(0);
  });

  it('PRE-05 markers have the same length as the final text', () => {
    expect(marker('password')).toHaveLength('[REDACTED:password]'.length);
  });

  it('PRE-05 safeCut never splits a marker or a surrogate pair', () => {
    const text = `ab${marker('jwt')}cd`;
    expect(safeCut(text, 6)).toBe(2);
    expect(safeCut(text, text.length)).toBe(text.length);
    expect(safeCut('a😀b', 2)).toBe(1);
    expect(safeCut('abc', 99)).toBe(3);
  });

  it('PRE-05 secretKind classifies keys by their last segment', () => {
    expect(secretKind('db.password')).toBe('password');
    expect(secretKind('GITHUB_TOKEN')).toBe('token');
    expect(secretKind('apiKey')).toBe('api_key');
    expect(secretKind('client-secret')).toBe('secret');
    expect(secretKind('privateKey')).toBe('secret');
    expect(secretKind('AWS_SECRET_ACCESS_KEY')).toBe('aws_secret_key');
    expect(secretKind('tokenCount')).toBeNull();
    expect(secretKind('passwordPolicy')).toBeNull();
  });

  it('PRE-05 Shannon entropy and the high-entropy predicate (length ≥ 20, H ≥ 4.0)', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(isHighEntropySecret('q8Zr4LmX2vPn7TbK9wYc3JdF')).toBe(true);
    expect(isHighEntropySecret('q8Zr4LmX2vPn7Tb')).toBe(false); // too short
    expect(isHighEntropySecret('aaaaaaaaaaaaaaaaaaaa1')).toBe(false); // low entropy
    expect(isHighEntropySecret('abcdefghijklmnopqrstuvwxyzABCD')).toBe(false); // no digit
    expect(isHighEntropySecret(`q8Zr4LmX2vPn7TbK9wYc3JdF${'x'.repeat(500)}`)).toBe(false); // too long
    expect(isHighEntropySecret('q8Zr4LmX 2vPn7TbK9wYc3JdF')).toBe(false); // whitespace
  });
});
