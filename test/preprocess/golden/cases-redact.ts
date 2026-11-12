/**
 * Golden fixture sources: PRE-05 (redaction). Every secret below is FAKE and shaped only to hit
 * the rule (AWS values are the official documentation examples). Each case has positives and
 * negatives (look-alikes that must survive).
 */
import { added, dedent, file, hunk, input, prd } from '../helpers';
import type { GoldenCase } from './types';

export const redactCases: GoldenCase[] = [
  {
    name: 'PRE-05 AWS access keys and AWS secret keys',
    input: input([
      added(
        'src/config/aws.ts',
        dedent(`
          export const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
          export const aws_secret_access_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
          // negatives: too short, lower case, embedded in a word
          export const notAKey = 'AKIAIOSFODNN7EXAMP';
          export const lower = 'akiaiosfodnn7example';
          export const word = 'XAKIAIOSFODNN7EXAMPLEX';
        `),
      ),
    ]),
  },
  {
    name: 'PRE-05 GitHub and GitLab tokens',
    input: input([
      added(
        'scripts/release.sh',
        dedent(`
          export GH_TOKEN=ghp_FAKE00000000000000000000000000000000
          curl -H "Authorization: token gho_FAKE00000000000000000000000000000000" https://api.github.com
          APP=ghs_FAKE11111111111111111111111111111111
          FINE=github_pat_FAKE0000000000000000000_FAKE000000000000000000000000000000000000000000000000000000
          GITLAB=glpat-FAKE000000000000000000
          # negatives
          echo ghp_short
          echo "see github_pat docs"
          echo glpat-short
        `),
      ),
    ]),
  },
  {
    name: 'PRE-05 Slack, Stripe and Google API keys',
    input: input([
      added(
        'src/integrations/keys.py',
        dedent(`
          SLACK_BOT = "xoxb-FAKE-0000-not-a-real-token"
          WEBHOOK = "https://hooks.slack.com/services/TFAKE0000/BFAKE0000/FAKEfakeFAKEfake"
          STRIPE = "sk_live_FAKE00000000"
          STRIPE_RESTRICTED = "rk_test_FAKE00000000"
          STRIPE_WEBHOOK = "whsec_FAKE0000000000000000"
          MAPS = "AIzaFAKE_0000000000000000000000000000-0"
          # negatives: publishable keys are public, prefixes alone are not secrets
          STRIPE_PUBLISHABLE = "pk_live_FAKE00000000"
          channel = "xoxb"
          docs = "sk_live_ is the prefix of live keys"
        `),
      ),
    ]),
  },
  {
    name: 'PRE-05 PEM private key blocks are masked and line numbers are preserved',
    input: input([
      added(
        'deploy/dev-key.pem',
        dedent(`
          -----BEGIN RSA PRIVATE KEY-----
          MIIEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE
          FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE
          -----END RSA PRIVATE KEY-----
          -----BEGIN CERTIFICATE-----
          MIIBFAKECERTIFICATESARENOTSECRETFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE
          -----END CERTIFICATE-----
        `),
      ),
      file(
        'src/auth/keys.ts',
        hunk(10, 10, [
          '   const fallback = `',
          '+-----BEGIN PRIVATE KEY-----',
          '+MIIEvFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
          '+FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
        ]),
      ),
    ]),
  },
  {
    name: 'PRE-05 JWTs are masked; a lone base64 JSON header is not',
    input: input([
      added(
        'test-data/session.http',
        dedent(`
          GET /api/me
          Cookie: session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFLXVzZXIiLCJleHAiOjB9.RkFLRS1zaWduYXR1cmUtMDAwMA
          X-Header-Only: eyJhbGciOiJIUzI1NiJ9
        `),
      ),
    ]),
  },
  {
    name: 'PRE-05 password, secret, token and api_key assignments; code references survive',
    input: input([
      added(
        'src/settings.ts',
        dedent(`
          const password = "hunter2!x";
          const config = { "apiKey": "abcd1234efgh", client_secret: 's3cr3tvalue9' };
          authToken := "tok_12345678"
          db.password = 'Pa55word'
          // negatives
          interface Login { password: string; token?: string }
          const token = getToken();
          const labels = { password: "Password", passwordHint: "Use 8+ characters" };
          const secret = process.env.APP_SECRET!;
          const empty = { password: "" };
          const maxTokens = 4096;
          const tokenizer = "cl100k_base";
        `),
      ),
      added(
        '.env.example',
        dedent(`
          DB_PASSWORD=supersecret
          STRIPE_API_KEY=changeme123
          API_TOKEN=\${API_TOKEN}
          SECRET_KEY=
          TOKEN_TTL=3600
        `),
      ),
      added(
        'deploy/values.yaml',
        dedent(`
          database:
            password: hunter2
            user: shop
          ci:
            token: \${{ secrets.DEPLOY_TOKEN }}
        `),
      ),
    ]),
  },
  {
    name: 'PRE-05 high-entropy strings only in assignments; SHAs, UUIDs, SRI and base64 images survive',
    input: input([
      added(
        'src/fixtures.ts',
        dedent(`
          export const sessionSeed = "q8Zr4LmX2vPn7TbK9wYc3JdF";
          export const signingSalt = 'Zx9Qw2Er7Ty4Ui1Op6As3Df8Gh5Jk0Lm';
          // negatives
          export const revision = "3f2c9b1a7e4d8f60c2b5a9e1d7f3c8b6a4e2d0f9";
          export const requestId = "123e4567-e89b-12d3-a456-426614174000";
          export const integrity = "sha512-q8Zr4LmX2vPn7TbK9wYc3JdFq8Zr4LmX2vPn7TbK9wYc3JdF";
          export const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
          export const avatar = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
          export const asset = "static/img/hero-banner-2x-retina.webp";
          export const short = "q8Zr4LmX2vPn7Tb";
        `),
      ),
      added(
        'docs/notes.md',
        'The sample nonce q8Zr4LmX2vPn7TbK9wYc3JdF appears in prose, not in an assignment.\n',
      ),
    ]),
  },
  {
    name: 'PRE-05 credentials in URLs and bearer tokens',
    input: input([
      added(
        'src/db.ts',
        dedent(`
          const url = "postgres://shop:FAKEpass123@db.internal:5432/shop";
          const headers = { Authorization: "Bearer FAKEbearer0000000000000000" };
          // negatives
          const tpl = "postgres://shop:\${DB_PASSWORD}@db.internal/shop";
          const site = "https://example.com/docs";
          const note = "Bearer tokens are described in RFC 6750";
        `),
      ),
    ]),
  },
  {
    name: 'PRE-05 PRD title, body, acceptance criteria and meta are redacted',
    input: input(
      [file('src/payments/stripe.ts', hunk(1, 1, ["-const mode = 'test';", "+const mode = 'live';"]))],
      [
        prd(
          '42',
          'Rotate key AKIAIOSFODNN7EXAMPLE before launch',
          dedent(`
            ## Context
            Ops pasted the staging password into the ticket: password = "hunter2!x"
            Use the token xoxb-FAKE-0000-not-a-real-token for the bot.
          `),
          ['Given STRIPE_KEY=sk_live_FAKE00000000 the checkout succeeds', 'No secrets are logged'],
          { reporter: 'ops', note: 'apiKey: abcd1234efgh' },
        ),
      ],
    ),
  },
];
