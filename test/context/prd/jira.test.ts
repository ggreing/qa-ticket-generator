import { MockAgent, fetch as undiciFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrdFetchError } from '../../../src/context/prd/errors';
import { createJiraProvider, type JiraOptions } from '../../../src/context/prd/jira';
import type { PrdRef } from '../../../src/core/contracts';
import { fixture } from '../helpers';

const SITE = 'https://acme.atlassian.net';
const options: JiraOptions = { baseUrl: SITE, email: 'bot@example.com', apiToken: 'jira-secret' };
const ref = (id = 'PROJ-123', url?: string): PrdRef => ({
  source: 'jira',
  id,
  raw: id,
  ...(url ? { url } : {}),
});
const signal = () => new AbortController().signal;
const issuePath = (key: string, fields = 'summary,description,status,issuetype') =>
  `/rest/api/3/issue/${key}?fields=${fields}`;

let agent: MockAgent;
let seenAuth: string[];

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  seenAuth = [];
});
afterEach(async () => {
  await agent.close();
});

/** Real HTTP stack (undici) with a MockAgent dispatcher instead of the network. */
const deps = () => ({
  fetch: ((url: string, init: RequestInit) =>
    undiciFetch(url, { ...(init as object), dispatcher: agent })) as unknown as typeof fetch,
  retry: { sleep: async () => undefined },
});

function reply(path: string, status: number, body: unknown, headers: Record<string, string> = {}) {
  agent
    .get(SITE)
    .intercept({ path, method: 'GET' })
    .reply(
      status,
      (opts) => {
        const h = opts.headers as Record<string, string>;
        seenAuth.push(h.authorization ?? h.Authorization ?? '');
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
      { headers: { 'content-type': 'application/json', ...headers } },
    );
}

describe('createJiraProvider', () => {
  it('PRD-09 is unconfigured when options are null', async () => {
    const p = createJiraProvider(null);
    expect(p.source).toBe('jira');
    expect(p.isConfigured()).toBe(false);
    await expect(p.fetch(ref(), signal())).rejects.toBeInstanceOf(PrdFetchError);
    expect(createJiraProvider(options).isConfigured()).toBe(true);
  });

  it('PRD-04 fetches summary/description/status/type with Basic auth and converts ADF', async () => {
    reply(issuePath('PROJ-123'), 200, fixture('jira/issue-coupon.json'));
    const doc = await createJiraProvider(options, deps()).fetch(ref(), signal());
    expect(seenAuth).toEqual([`Basic ${Buffer.from('bot@example.com:jira-secret').toString('base64')}`]);
    expect(doc.title).toBe('Apply a coupon at checkout');
    expect(doc.url).toBe(`${SITE}/browse/PROJ-123`);
    expect(doc.meta).toEqual({ key: 'PROJ-123', status: 'In Progress', issueType: 'Story' });
    expect(doc.bodyMarkdown).toContain('## Acceptance Criteria');
    expect(doc.bodyMarkdown).toContain('**coupon code**');
    // PRD-07 — from the description's AC heading.
    expect(doc.acceptanceCriteria).toEqual([
      'AC1: a coupon can be applied once per order; also across devices',
      'AC2: the discount shows before payment',
      'AC3: expired coupons are rejected',
    ]);
    agent.assertNoPendingInterceptors();
  });

  it('PRD-04 reads the AC custom field when it is ADF', async () => {
    const acAdf = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Field AC one' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Field AC two' }] }],
            },
          ],
        },
      ],
    };
    reply(issuePath('PROJ-9', 'summary,description,status,issuetype,customfield_10042'), 200, {
      key: 'PROJ-9',
      fields: {
        summary: 'With AC field',
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body.' }] }],
        },
        customfield_10042: acAdf,
      },
    });
    const doc = await createJiraProvider(
      { ...options, acceptanceCriteriaField: 'customfield_10042' },
      deps(),
    ).fetch(ref('PROJ-9'), signal());
    expect(doc.acceptanceCriteria).toEqual(['Field AC one', 'Field AC two']);
    expect(doc.bodyMarkdown).toBe('Body.\n\n## Acceptance Criteria\n\n- Field AC one\n- Field AC two');
    expect(doc.meta).toEqual({ key: 'PROJ-9' });
  });

  it('PRD-04 reads the AC custom field when it is plain text or a list', async () => {
    reply(issuePath('PROJ-10', 'summary,description,status,issuetype,cf'), 200, {
      key: 'PROJ-10',
      fields: { summary: null, description: null, cf: 'Users can apply one coupon\nExpired coupons fail' },
    });
    const p = createJiraProvider({ ...options, acceptanceCriteriaField: 'cf' }, deps());
    const doc = await p.fetch(ref('PROJ-10'), signal());
    expect(doc.title).toBe('PROJ-10');
    expect(doc.acceptanceCriteria).toEqual(['Users can apply one coupon', 'Expired coupons fail']);

    reply(issuePath('PROJ-11', 'summary,description,status,issuetype,cf'), 200, {
      key: 'PROJ-11',
      fields: {
        summary: 'List',
        cf: [
          'first',
          { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
        ],
      },
    });
    const doc2 = await p.fetch(ref('PROJ-11'), signal());
    expect(doc2.acceptanceCriteria).toEqual(['first', 'second']);
  });

  it('PRD-04 falls back to the description when the AC field is empty', async () => {
    reply(issuePath('PROJ-12', 'summary,description,status,issuetype,cf'), 200, {
      key: 'PROJ-12',
      fields: { summary: 's', description: 'not adf', cf: null },
    });
    const doc = await createJiraProvider({ ...options, acceptanceCriteriaField: 'cf' }, deps()).fetch(
      ref('PROJ-12'),
      signal(),
    );
    expect(doc.bodyMarkdown).toBe('not adf');
    expect(doc.acceptanceCriteria).toEqual([]);
  });

  it('PRD-08 maps 401/403/404/500 to safe PrdFetchErrors without response bodies', async () => {
    const p = createJiraProvider(options, deps());
    const cases: [number, PrdFetchError['kind']][] = [
      [401, 'auth'],
      [403, 'http'],
      [404, 'not_found'],
    ];
    for (const [status, kind] of cases) {
      reply(issuePath('PROJ-1'), status, { errorMessages: ['SECRET BODY TEXT'] });
      const err = (await p.fetch(ref('PROJ-1'), signal()).catch((e: unknown) => e)) as PrdFetchError;
      expect(err).toBeInstanceOf(PrdFetchError);
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.message).toContain(`HTTP ${status}`);
      expect(err.message).not.toContain('SECRET');
      expect(err.message).not.toContain('jira-secret');
    }
  });

  it('PRD-08 retries 429/5xx twice, then fails', async () => {
    const pool = agent.get(SITE);
    pool
      .intercept({ path: issuePath('PROJ-2'), method: 'GET' })
      .reply(503, '{}')
      .times(1);
    pool
      .intercept({ path: issuePath('PROJ-2'), method: 'GET' })
      .reply(429, '{}', { headers: { 'retry-after': '1' } });
    pool
      .intercept({ path: issuePath('PROJ-2'), method: 'GET' })
      .reply(200, JSON.stringify({ key: 'PROJ-2', fields: { summary: 'ok' } }));
    await expect(createJiraProvider(options, deps()).fetch(ref('PROJ-2'), signal())).resolves.toMatchObject({
      title: 'ok',
    });

    pool
      .intercept({ path: issuePath('PROJ-3'), method: 'GET' })
      .reply(500, '{}')
      .times(3);
    await expect(createJiraProvider(options, deps()).fetch(ref('PROJ-3'), signal())).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
    agent.assertNoPendingInterceptors();
  });

  it('PRD-08 reports unreadable JSON without echoing it', async () => {
    reply(issuePath('PROJ-4'), 200, '<html>login page SECRET</html>');
    const err = (await createJiraProvider(options, deps())
      .fetch(ref('PROJ-4'), signal())
      .catch((e: unknown) => e)) as PrdFetchError;
    expect(err.kind).toBe('http');
    expect(err.message).not.toContain('SECRET');
  });

  it('PRD-04 rejects invalid keys, foreign Jira sites and bad field ids before any request', async () => {
    const p = createJiraProvider(options, deps());
    await expect(p.fetch(ref('not a key'), signal())).rejects.toMatchObject({ kind: 'invalid_ref' });
    await expect(
      p.fetch(ref('PROJ-1', 'https://other.atlassian.net/browse/PROJ-1'), signal()),
    ).rejects.toMatchObject({
      kind: 'invalid_ref',
    });
    await expect(
      createJiraProvider({ ...options, acceptanceCriteriaField: 'x,y' }, deps()).fetch(
        ref('PROJ-1'),
        signal(),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_ref' });
  });

  it('PRD-04 accepts refs whose URL is on the configured site and lower-case keys', async () => {
    reply(issuePath('PROJ-5'), 200, { key: 'PROJ-5', fields: { summary: 'x' } });
    await expect(
      createJiraProvider({ ...options, baseUrl: `${SITE}/` }, deps()).fetch(
        ref('proj-5', `${SITE}/browse/PROJ-5`),
        signal(),
      ),
    ).resolves.toMatchObject({ url: `${SITE}/browse/PROJ-5` });
  });

  it('PRD-08 propagates aborts', async () => {
    agent
      .get(SITE)
      .intercept({ path: issuePath('PROJ-6'), method: 'GET' })
      .reply(200, '{}')
      .delay(5_000);
    const ctrl = new AbortController();
    const p = createJiraProvider(options, deps()).fetch(ref('PROJ-6'), ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
