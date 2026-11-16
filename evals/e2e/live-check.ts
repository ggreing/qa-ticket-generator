/**
 * Live check of the Jira and Notion case sinks against real accounts (v0.2). No LLM: three fixed
 * cases go through the real sinks, the real renderCase and the real planSync, step by step:
 *
 *   1 create            three tickets
 *   2 list round trip   read back as written, nothing to do
 *   3 same-text update  only the tool's record moves (Jira: the qtg.case issue property)
 *   4 people's fields   kept across a text update (what can be set automatically; the rest is printed)
 *   5 one-char edit     a hand edit turns the next update into one proposal comment
 *   6 obsolete          a dropped case is marked once, never deleted
 *   7 summary           the spec-side case list (Jira story comment; Notion has none by design)
 *
 * Dry run by default: prints the plan and which variables are set, and sends nothing. `--yes`
 * writes. `--cleanup` closes (Jira, a `done` transition) or trashes (Notion) what this run created.
 * Never prints tokens or case text, only keys, ids, URLs and counts.
 *
 * Run: node evals/e2e/sinks-live.mjs [--yes] [--only jira|notion] [--cleanup]
 * Owner: qa-work-session-a.
 */
import { planSync, renderCase } from '../../src/cases';
import type {
  CaseSetSummary,
  CaseSink,
  ExistingCaseTicket,
  QaCase,
  RenderedCase,
} from '../../src/core/cases';
import type { Logger, PrdRef } from '../../src/core/contracts';
import { QtgError } from '../../src/core/errors';
import { suggestMarker } from '../../src/sinks/common';
import { CASE_PROPERTY, createJiraCaseSink, PAYLOAD_TITLE } from '../../src/sinks/jira';
import { createNotionCaseSink, PROP } from '../../src/sinks/notion';

type Fetch = typeof globalThis.fetch;
type Target = 'jira' | 'notion';
export type Status = 'PASS' | 'FAIL' | 'SKIP' | 'MANUAL';
export interface StepResult {
  target: Target;
  step: string;
  status: Status;
  detail: string;
}

export interface LiveOptions {
  yes: boolean;
  only?: Target;
  cleanup: boolean;
  env: Record<string, string | undefined>;
  fetch?: Fetch;
  print?: (line: string) => void;
  now?: () => Date;
  /** Tests: no backoff waits in the sinks. */
  retry?: { sleep: (ms: number) => Promise<void> };
}

const JIRA_VARS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT'] as const;
const NOTION_VARS = ['NOTION_TOKEN', 'NOTION_QA_DATABASE_ID'] as const;
const OPTIONAL_VARS = ['JIRA_STORY', 'JIRA_STORY_TYPE', 'JIRA_SUBTASK_TYPE'] as const;
const NOTION_VERSION = '2025-09-03';
const HUMAN_LABEL = 'qtg-live-human';
const HUMAN_NOTE = 'A note from a person (qtg live check).';
const LANGUAGE = 'en' as const;

const render = (c: QaCase): RenderedCase => renderCase(c, LANGUAGE);
const kinds = (ops: ReturnType<typeof planSync>) => ops.map((o) => o.op);
const stampOf = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** Three synthetic cases (P0/P1/P2); nothing here comes from a real spec. */
export function liveCases(specId: string): QaCase[] {
  const common = {
    specRef: specId,
    lifecycle: 'active' as const,
    origin: 'spec' as const,
    specDigest: 'live-1',
  };
  return [
    {
      ...common,
      caseId: `${specId}-C01`,
      title: 'Apply a coupon that expired one second ago',
      acLabels: ['AC1'],
      technique: 'boundary',
      priority: 'P0',
      preconditions: ['Coupon EXP1 expires at 23:59:59'],
      testData: ['Coupon code EXP1', 'Clock at 00:00:00 the next day'],
      steps: ['Open checkout', 'Enter EXP1 and apply'],
      expected: ['The coupon is rejected', 'The total does not change'],
      whyEasyToMiss: 'The spec does not say whether the expiry second itself is still valid',
    },
    {
      ...common,
      caseId: `${specId}-C02`,
      title: 'Apply a coupon code with trailing spaces',
      acLabels: ['AC2'],
      technique: 'invalid_input',
      priority: 'P1',
      preconditions: ['Coupon SAVE10 is active'],
      testData: ['Coupon code "SAVE10  "'],
      steps: ['Open checkout', 'Enter the code with two trailing spaces and apply'],
      expected: ['The coupon is applied once'],
      whyEasyToMiss: 'Input trimming is not mentioned in the spec',
    },
    {
      ...common,
      caseId: `${specId}-C03`,
      title: 'A guest tries to apply a members-only coupon',
      acLabels: ['AC3'],
      technique: 'permission',
      priority: 'P2',
      preconditions: ['Coupon VIP5 is for members only', 'The shopper is not signed in'],
      testData: ['Coupon code VIP5'],
      steps: ['Open checkout as a guest', 'Enter VIP5 and apply'],
      expected: ['The shopper is asked to sign in'],
      whyEasyToMiss: 'Guest checkout is described in another document',
    },
  ];
}

/** Target-specific actions a person (or the check) takes outside the sink. */
interface Probe {
  setHumanFields(
    ref: string,
  ): Promise<{ check: (t: ExistingCaseTicket) => Promise<string | null>; manual: string }>;
  editOneChar(ref: string, caseId: string): Promise<void>;
  suggestionCount(ref: string, caseId: string): Promise<number>;
  /** Extra evidence that the same-text update took the quiet path; null = fine. */
  sameTextEvidence(ref: string, digest: string): Promise<string | null>;
  close(ref: string): Promise<string>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what}: HTTP ${status}`);
  }
}

async function call(fetch: Fetch, url: string, init: RequestInit, what: string): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, what); // never the body: it may echo content
  const text = res.status === 204 ? '' : await res.text();
  return text ? JSON.parse(text) : null;
}

const describeError = (err: unknown) =>
  err instanceof QtgError ? err.userMessage : err instanceof Error ? err.message : String(err);

// ───────────────────────────── Jira ─────────────────────────────

function jiraProbe(
  fetch: Fetch,
  base: string,
  auth: string,
): Probe & { createStory: (project: string, type: string, stamp: string) => Promise<string> } {
  const jira = (method: string, path: string, what: string, body?: unknown) =>
    call(
      fetch,
      `${base}${path}`,
      {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      what,
    );
  const doc = (text: string) => ({
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const comments = async (ref: string) =>
    (
      (await jira('GET', `/rest/api/3/issue/${ref}/comment?maxResults=100`, 'reading comments')) as {
        comments: { body: unknown }[];
      }
    ).comments;

  return {
    async createStory(project, type, stamp) {
      const created = (await jira('POST', '/rest/api/3/issue', 'creating the test story', {
        fields: {
          project: { key: project },
          issuetype: { name: type },
          summary: `qtg live check ${stamp}`,
          description: doc('Created by evals/e2e/sinks-live.mjs. Safe to close.'),
          labels: ['qtg-live-check'],
        },
      })) as { key: string };
      return created.key;
    },
    async setHumanFields(ref) {
      await jira('PUT', `/rest/api/3/issue/${ref}`, 'adding a label', {
        update: { labels: [{ add: HUMAN_LABEL }] },
      });
      await jira('POST', `/rest/api/3/issue/${ref}/comment`, 'adding a comment', { body: doc(HUMAN_NOTE) });
      return {
        check: async () => {
          const issue = (await jira('GET', `/rest/api/3/issue/${ref}?fields=labels`, 'reading labels')) as {
            fields: { labels?: string[] };
          };
          if (!issue.fields.labels?.includes(HUMAN_LABEL)) return `label ${HUMAN_LABEL} was removed`;
          const kept = (await comments(ref)).some((c) => JSON.stringify(c.body).includes(HUMAN_NOTE));
          return kept ? null : 'the comment people added is gone';
        },
        manual: `Assignee and status: assign ${ref} and move it to another status, then run the action again; both must stay as you set them.`,
      };
    },
    async editOneChar(ref) {
      const issue = (await jira(
        'GET',
        `/rest/api/3/issue/${ref}?fields=description`,
        'reading the description',
      )) as {
        fields: { description: { content: Record<string, unknown>[] } };
      };
      const content = issue.fields.description.content;
      const end = content.findIndex(
        (n) => (n.attrs as { title?: string } | undefined)?.title === PAYLOAD_TITLE,
      );
      const toolArea = end < 0 ? content : content.slice(0, end);
      const findText = (nodes: unknown[]): { text: string } | null => {
        for (const n of nodes as Record<string, unknown>[]) {
          if (n.type === 'text' && typeof n.text === 'string') return n as { text: string };
          const inner = Array.isArray(n.content) ? findText(n.content) : null;
          if (inner) return inner;
        }
        return null;
      };
      const node = findText(toolArea);
      if (!node) throw new Error('no text in the tool area to edit');
      node.text = `${node.text}!`;
      await jira('PUT', `/rest/api/3/issue/${ref}`, 'editing the description', {
        fields: { description: issue.fields.description },
      });
    },
    async suggestionCount(ref, caseId) {
      return (await comments(ref)).filter((c) => JSON.stringify(c.body).includes(suggestMarker(caseId)))
        .length;
    },
    async sameTextEvidence(ref, digest) {
      try {
        const prop = (await jira(
          'GET',
          `/rest/api/3/issue/${ref}/properties/${CASE_PROPERTY}`,
          'reading the property',
        )) as {
          value?: { case?: { specDigest?: string } };
        };
        return prop.value?.case?.specDigest === digest
          ? null
          : `${CASE_PROPERTY} does not hold the new record`;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          return `${CASE_PROPERTY} is missing: the sink fell back to rewriting the description (watchers were mailed)`;
        }
        throw err;
      }
    },
    async close(ref) {
      const { transitions } = (await jira(
        'GET',
        `/rest/api/3/issue/${ref}/transitions`,
        'reading transitions',
      )) as {
        transitions: { id: string; to?: { statusCategory?: { key?: string } } }[];
      };
      const done = transitions.find((t) => t.to?.statusCategory?.key === 'done');
      if (!done) return `${ref}: no transition to a done status; close it by hand`;
      await jira('POST', `/rest/api/3/issue/${ref}/transitions`, 'closing', { transition: { id: done.id } });
      return `${ref}: closed`;
    },
  };
}

// ───────────────────────────── Notion ─────────────────────────────

function notionProbe(fetch: Fetch, token: string): Probe {
  const notion = (method: string, path: string, what: string, body?: unknown) =>
    call(
      fetch,
      `https://api.notion.com/v1/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      what,
    );
  type Block = { id: string; type: string } & Record<string, unknown>;
  const plain = (rich: unknown) =>
    ((rich as { plain_text?: string; text?: { content?: string } }[]) ?? [])
      .map((t) => t.plain_text ?? t.text?.content ?? '')
      .join('');
  const children = async (id: string) =>
    ((await notion('GET', `blocks/${id}/children?page_size=100`, 'reading blocks')) as { results: Block[] })
      .results;
  const comments = async (ref: string) =>
    (
      (await notion('GET', `comments?block_id=${ref}`, 'reading comments')) as {
        results: { rich_text: unknown }[];
      }
    ).results;

  return {
    async setHumanFields(ref) {
      await notion('PATCH', `pages/${ref}`, 'setting the result', {
        properties: { [PROP.exec]: { select: { name: 'Pass' } } },
      });
      return {
        check: async (t) =>
          t.human.execStatus === 'Pass'
            ? null
            : `${PROP.exec} was not kept (now "${t.human.execStatus ?? ''}")`,
        manual: `${PROP.assignee}: set a person on the row ${ref}, then run the action again; it must stay.`,
      };
    },
    async editOneChar(ref, caseId) {
      const container = (await children(ref)).find(
        (b) => b.type === 'quote' && plain((b.quote as { rich_text?: unknown })?.rich_text).trim() === caseId,
      );
      if (!container) throw new Error('the case block was not found on the page');
      const target = (await children(container.id)).find((b) =>
        Array.isArray((b[b.type] as { rich_text?: unknown[] } | undefined)?.rich_text),
      );
      if (!target) throw new Error('no text block to edit');
      const text = plain((target[target.type] as { rich_text: unknown }).rich_text);
      await notion('PATCH', `blocks/${target.id}`, 'editing a block', {
        [target.type]: { rich_text: [{ type: 'text', text: { content: `${text}!` } }] },
      });
    },
    async suggestionCount(ref, caseId) {
      return (await comments(ref)).filter((c) => plain(c.rich_text).includes(suggestMarker(caseId))).length;
    },
    async sameTextEvidence() {
      return null; // the list check covers it: the row record moved, the page body was not touched
    },
    async close(ref) {
      await notion('PATCH', `pages/${ref}`, 'moving to trash', { in_trash: true });
      return `${ref}: moved to trash`;
    },
  };
}

// ───────────────────────────── steps ─────────────────────────────

async function runTarget(
  target: Target,
  sink: CaseSink,
  probe: Probe,
  spec: PrdRef,
  report: (step: string, status: Status, detail: string) => void,
): Promise<string[]> {
  const signal = new AbortController().signal;
  const created: string[] = [];
  const cases = liveCases(spec.id);
  const step = async (name: string, fn: () => Promise<[Status, string]>) => {
    try {
      const [status, detail] = await fn();
      report(name, status, detail);
      return status === 'PASS';
    } catch (err) {
      report(name, 'FAIL', describeError(err));
      return false;
    }
  };
  const list = () => sink.list(spec, signal);
  const ticket = (all: ExistingCaseTicket[], c: QaCase) => all.find((t) => t.caseId === c.caseId);

  // 1 create
  const refs = new Map<string, string>();
  const ok = await step('1 create', async () => {
    const urls: string[] = [];
    for (const c of cases) {
      const res = await sink.create(spec, c, render(c), signal);
      refs.set(c.caseId, res.ticketRef);
      created.push(res.ticketRef);
      urls.push(res.url || res.ticketRef);
    }
    return [refs.size === 3 ? 'PASS' : 'FAIL', `${refs.size} ticket(s): ${urls.join(', ')}`];
  });
  if (!ok) return created;

  // 2 list round trip
  await step('2 list round trip', async () => {
    const all = await list();
    const edited = all.filter((t) => t.currentHash !== t.writtenHash).map((t) => t.caseId);
    const ops = kinds(planSync(all, cases, render));
    const pass = all.length === 3 && edited.length === 0 && ops.every((o) => o === 'unchanged');
    return [
      pass ? 'PASS' : 'FAIL',
      `${all.length} read back, edited: ${edited.length}, ops: ${ops.join(',')}`,
    ];
  });

  // 3 same-text update (only specDigest moves)
  const v2 = cases.map((c) => ({ ...c, specDigest: 'live-2' }));
  await step('3 same-text update', async () => {
    const ops = planSync(await list(), v2, render);
    if (!ops.every((o) => o.op === 'update'))
      return ['FAIL', `expected update ×3, got ${kinds(ops).join(',')}`];
    for (const op of ops)
      if (op.op === 'update') await sink.update(op.ticket, op.case, render(op.case), signal);
    const all = await list();
    const stale = all.filter((t) => t.lastWritten?.specDigest !== 'live-2').map((t) => t.caseId);
    const again = kinds(planSync(all, v2, render));
    const evidence = await probe.sameTextEvidence(refs.get(cases[0]?.caseId ?? '') ?? '', 'live-2');
    const pass = stale.length === 0 && again.every((o) => o === 'unchanged') && evidence === null;
    return [
      pass ? 'PASS' : 'FAIL',
      evidence ?? `records moved: ${3 - stale.length}/3, next ops: ${again.join(',')}`,
    ];
  });

  // 4 people's fields survive a text update
  const c1 = v2[0] as QaCase;
  const c1b = { ...c1, expected: [...c1.expected, 'No order is created'] };
  let manual = '';
  await step('4 people fields kept', async () => {
    const human = await probe.setHumanFields(refs.get(c1.caseId) ?? '');
    manual = human.manual;
    const op = planSync(await list(), [c1b, ...v2.slice(1)], render).find((o) => o.op !== 'unchanged');
    if (op?.op !== 'update')
      return ['FAIL', `expected an update for ${c1.caseId}, got ${op?.op ?? 'nothing'}`];
    await sink.update(op.ticket, op.case, render(op.case), signal);
    const t = ticket(await list(), c1);
    if (!t) return ['FAIL', `${c1.caseId} is gone`];
    const problem = await human.check(t);
    const textMoved = t.lastWritten?.expected.includes('No order is created') ?? false;
    return [
      problem === null && textMoved ? 'PASS' : 'FAIL',
      problem ?? (textMoved ? 'kept, text updated' : 'text not updated'),
    ];
  });
  if (manual) report('4 people fields kept', 'MANUAL', manual);

  // 5 one-char edit by a person → one proposal comment
  const c2 = v2[1] as QaCase;
  const c2b = { ...c2, expected: [...c2.expected, 'The error names the field'] };
  await step('5 one-char edit → suggest', async () => {
    await probe.editOneChar(refs.get(c2.caseId) ?? '', c2.caseId);
    const next = [c1b, c2b, v2[2] as QaCase];
    const op = planSync(await list(), next, render).find((o) => o.op !== 'unchanged');
    if (op?.op !== 'suggest')
      return ['FAIL', `expected suggest for ${c2.caseId}, got ${op?.op ?? 'nothing'}`];
    await sink.suggest(op.ticket, op.case, render(op.case), signal);
    await sink.suggest(op.ticket, op.case, render(op.case), signal); // in place, not a second comment
    const n = await probe.suggestionCount(refs.get(c2.caseId) ?? '', c2.caseId);
    return [n === 1 ? 'PASS' : 'FAIL', `${n} proposal comment(s) after two runs`];
  });

  // 6 the spec drops a case → obsolete once
  const c3 = v2[2] as QaCase;
  await step('6 obsolete', async () => {
    const ops = planSync(await list(), [c1b, c2b], render);
    const op = ops.find((o) => o.op === 'obsolete');
    if (op?.op !== 'obsolete')
      return ['FAIL', `expected obsolete for ${c3.caseId}, got ${kinds(ops).join(',')}`];
    await sink.markObsolete(op.ticket, signal);
    const all = await list();
    const marked = ticket(all, c3)?.lastWritten?.lifecycle === 'obsolete';
    const again = kinds(planSync(all, [c1b, c2b], render)).filter((k) => k === 'obsolete').length;
    return [
      marked && again === 0 ? 'PASS' : 'FAIL',
      `marked: ${marked}, still kept as a ticket, obsolete ops next run: ${again}`,
    ];
  });

  // 7 the spec-side summary
  await step('7 summary', async () => {
    const all = await list();
    const live = [c1b, c2b, { ...c3, lifecycle: 'obsolete' as const }];
    const summary: CaseSetSummary = {
      specRef: spec,
      specTitle: 'qtg live check',
      language: LANGUAGE,
      cases: live.map((c) => ({
        caseId: c.caseId,
        title: c.title,
        priority: c.priority,
        lifecycle: c.lifecycle,
        url: ticket(all, c)?.url,
      })),
      counts: { total: 2, byPriority: { P0: 1, P1: 1, P2: 0 }, obsolete: 1 },
      meta: { model: 'none (live check)', costUsd: 0, mode: 'plan' },
    };
    const res = await sink.publishSummary(spec, summary, signal);
    if (target === 'notion') return ['SKIP', 'Notion keeps no spec-side case list (by design)'];
    return [res.url ? 'PASS' : 'FAIL', res.url ?? 'no summary comment URL'];
  });
  return created;
}

// ───────────────────────────── entry ─────────────────────────────

export async function runLiveCheck(o: LiveOptions): Promise<{ results: StepResult[]; exitCode: number }> {
  const print = o.print ?? ((line: string) => console.log(line));
  const fetch = o.fetch ?? globalThis.fetch;
  const env = o.env;
  const results: StepResult[] = [];
  const has = (names: readonly string[]) => names.every((n) => (env[n] ?? '').trim() !== '');
  const wanted: Target[] = o.only ? [o.only] : ['jira', 'notion'];
  const ready = wanted.filter((t) => has(t === 'jira' ? JIRA_VARS : NOTION_VARS));

  print('qtg sinks live check');
  for (const t of wanted) {
    const vars = t === 'jira' ? JIRA_VARS : NOTION_VARS;
    print(`  ${t}: ${vars.map((v) => `${v}=${(env[v] ?? '').trim() ? 'set' : 'missing'}`).join(' ')}`);
  }
  print(`  optional: ${OPTIONAL_VARS.map((v) => `${v}=${(env[v] ?? '').trim() ? 'set' : '-'}`).join(' ')}`);
  if (ready.length === 0) {
    print('Nothing to check: set the variables above for Jira and/or Notion.');
    return { results, exitCode: 2 };
  }
  if (!o.yes) {
    print('');
    print(`Dry run. With --yes this writes to ${ready.join(' and ')}:`);
    print('  1 create 3 case tickets   2 list round trip   3 same-text update   4 people fields kept');
    print('  5 one-char edit → suggest  6 obsolete          7 summary');
    if (ready.includes('jira') && !(env.JIRA_STORY ?? '').trim()) {
      print(
        `  Jira: a new ${env.JIRA_STORY_TYPE || 'Story'} is created in ${env.JIRA_PROJECT} to hold the sub-tasks (or set JIRA_STORY).`,
      );
    }
    print(
      `  ${o.cleanup ? 'Afterwards the tickets are closed (Jira) or moved to trash (Notion).' : 'The tickets are kept; add --cleanup to close or trash them afterwards.'}`,
    );
    return { results, exitCode: 0 };
  }

  const stamp = stampOf((o.now ?? (() => new Date()))());
  const logger: Logger = {
    debug: () => undefined,
    info: (m) => print(`    · ${m}`),
    warn: (m) => print(`    ! ${m}`),
    error: (m) => print(`    ✗ ${m}`),
    group: async (_name, fn) => fn(),
  };
  const ctx = { logger, language: LANGUAGE };
  const retry = o.retry ? { retry: o.retry } : {};

  for (const t of ready) {
    const report = (step: string, status: Status, detail: string) => {
      results.push({ target: t, step, status, detail });
      print(`[${t}] ${status.padEnd(6)} ${step}: ${detail}`);
    };
    let created: string[] = [];
    let probe: Probe;
    try {
      if (t === 'jira') {
        const base = (env.JIRA_BASE_URL ?? '').trim().replace(/\/+$/, '');
        const auth = Buffer.from(`${env.JIRA_EMAIL?.trim()}:${env.JIRA_API_TOKEN?.trim()}`).toString(
          'base64',
        );
        const jira = jiraProbe(fetch, base, auth);
        probe = jira;
        let story = (env.JIRA_STORY ?? '').trim();
        if (!story) {
          story = await jira.createStory(
            (env.JIRA_PROJECT ?? '').trim(),
            (env.JIRA_STORY_TYPE ?? '').trim() || 'Story',
            stamp,
          );
          report('0 story', 'PASS', `${story} created to hold the sub-tasks (${base}/browse/${story})`);
        }
        const sink = createJiraCaseSink(
          {
            baseUrl: base,
            email: (env.JIRA_EMAIL ?? '').trim(),
            apiToken: (env.JIRA_API_TOKEN ?? '').trim(),
            subtaskType: (env.JIRA_SUBTASK_TYPE ?? '').trim() || 'Sub-task',
          },
          ctx,
          { fetch, ...retry },
        );
        created = await runTarget(
          t,
          sink,
          probe,
          { source: 'jira', id: story, raw: story, url: `${base}/browse/${story}` },
          report,
        );
        if (o.cleanup && !(env.JIRA_STORY ?? '').trim()) created.push(story);
      } else {
        const token = (env.NOTION_TOKEN ?? '').trim();
        probe = notionProbe(fetch, token);
        const sink = createNotionCaseSink(
          { token, databaseId: (env.NOTION_QA_DATABASE_ID ?? '').trim() },
          ctx,
          { fetch: fetch as (u: string, i?: RequestInit) => Promise<Response> },
        );
        const id = `LIVE-${stamp}`;
        created = await runTarget(t, sink, probe, { source: 'notion', id, raw: id }, report);
      }
    } catch (err) {
      report('setup', 'FAIL', describeError(err));
      continue;
    }
    if (o.cleanup) {
      for (const ref of created) {
        try {
          report('cleanup', 'PASS', await probe.close(ref));
        } catch (err) {
          report('cleanup', 'FAIL', `${ref}: ${describeError(err)}`);
        }
      }
    } else if (created.length) {
      print(`[${t}] kept: ${created.join(', ')} (run again with --cleanup next time, or close them by hand)`);
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  print('');
  print(
    failed
      ? `${failed} step(s) failed.`
      : 'All automatic steps passed. See MANUAL lines for what to check by hand.',
  );
  return { results, exitCode: failed ? 1 : 0 };
}

export function parseArgs(argv: string[]): Pick<LiveOptions, 'yes' | 'only' | 'cleanup'> {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;
  if (only !== undefined && only !== 'jira' && only !== 'notion')
    throw new Error('--only takes jira or notion');
  return { yes: argv.includes('--yes'), cleanup: argv.includes('--cleanup'), ...(only ? { only } : {}) };
}
