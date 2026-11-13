/** GitHub Issue case sink (SPEC v3 §4, §5). Owner: qa-work-session-a. */

import { type RetryOptions, statusOf, withRetry } from '../context/retry';
import type {
  CaseSetSummary,
  CaseSink,
  ExistingCaseTicket,
  HumanFields,
  QaCase,
  RenderedCase,
  SinkContext,
} from '../core/cases';
import type { Language, PrdRef } from '../core/contracts';
import { QtgError } from '../core/errors';
import type { Octokit } from '../core/octokit';
import {
  areaDigest,
  decodePayload,
  encodePayload,
  OBSOLETE_TICKET_LABEL,
  obsoleteTitle,
  type SinkPayload,
  sinkError,
  suggestMarker,
  summaryLines,
  summaryMarker,
  ticketFrom,
} from './common';

export const GH_CASE_LABEL = 'qa-case';
/** Labels people set to record results (§5); read as execStatus, never written. */
const EXEC_LABEL = /^qa:(pass|fail|blocked|skip(?:ped)?)$/i;
const ACTIONS_BOT = 'github-actions[bot]';
const MAX_LABEL = 50;

export interface GitHubIssueSinkOptions {
  owner: string;
  repo: string;
  /** Login whose issues/comments are trusted; defaults to GET /user, or github-actions[bot]. */
  trustedAuthor?: string;
}

export interface GitHubIssueSinkDeps {
  retry?: RetryOptions;
}

const PROPOSED: Record<Language, { heading: string; note: string; details: string }> = {
  en: {
    heading: 'Tool-proposed change',
    note: 'This ticket was edited by hand, so the tool did not overwrite it. Proposed version:',
    details: 'Proposed title and body',
  },
  ko: {
    heading: '도구 제안 변경',
    note: '이 티켓은 사람이 수정해 도구가 덮어쓰지 않음. 제안 내용:',
    details: '제안 제목과 본문',
  },
  ja: {
    heading: 'ツールからの変更提案',
    note: 'このチケットは手動で編集されているため上書きしていません。提案内容:',
    details: '提案タイトルと本文',
  },
  'zh-CN': {
    heading: '工具建议的修改',
    note: '此工单已被手动修改,工具未覆盖。建议内容:',
    details: '建议的标题和正文',
  },
};

const caseMarker = (caseId: string) => `<!-- qtg-case:${caseId} -->`;
const CASE_MARKER = /<!-- qtg-case:([A-Za-z0-9._-]+) -->/;
const DATA = /<!-- qtg-data:([A-Za-z0-9+/=]+) -->/;

/** Splits an issue body into the tool-owned area, the payload and what people added after it. */
export function splitBody(body: string): {
  caseId: string | null;
  tool: string;
  payload: string | null;
  tail: string;
} {
  const marker = body.match(CASE_MARKER);
  if (!marker || marker.index === undefined) return { caseId: null, tool: body, payload: null, tail: '' };
  const tool = body.slice(0, marker.index);
  const rest = body.slice(marker.index + marker[0].length);
  const data = rest.match(DATA);
  const dataEnd =
    data?.index !== undefined && /^\s*$/.test(rest.slice(0, data.index)) ? data.index + data[0].length : 0;
  return {
    caseId: marker[1] ?? null,
    tool,
    payload: dataEnd ? (data?.[1] ?? null) : null,
    tail: rest.slice(dataEnd).replace(/^\n/, ''),
  };
}

export function composeBody(tool: string, payload: SinkPayload, tail: string): string {
  const head = `${tool.trimEnd()}\n\n${caseMarker(payload.caseId)}\n<!-- qtg-data:${encodePayload(payload)} -->`;
  return tail.trim() ? `${head}\n${tail}` : head;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function clipLabel(label: string): string {
  return label.length <= MAX_LABEL ? label : label.slice(0, MAX_LABEL);
}

/**
 * Creates the GitHub Issue sink: one issue per case in `owner/repo`, labelled `qa-case`,
 * `qa-p0|p1|p2` and `qtg-spec-<n>`. People own open/closed, assignees and every other label.
 */
export function createGitHubIssueCaseSink(
  octokit: Octokit,
  options: GitHubIssueSinkOptions,
  ctx: SinkContext,
  deps: GitHubIssueSinkDeps = {},
): CaseSink {
  const { owner, repo } = options;
  const target = { owner, repo };
  const call = <T>(fn: () => Promise<T>, action: string): Promise<T> =>
    withRetry(fn, deps.retry).catch((err: unknown) => {
      throw sinkError(err, 'GitHub Issue sink', action);
    });

  let identity: Promise<string> | undefined;
  const me = (): Promise<string> => {
    identity ??= (async () => {
      if (options.trustedAuthor?.trim()) return options.trustedAuthor.trim().toLowerCase();
      try {
        const { data } = await withRetry(() => octokit.rest.users.getAuthenticated(), deps.retry);
        return data.login.toLowerCase();
      } catch (err) {
        const status = statusOf(err);
        if (status === 403 || status === 404) return ACTIONS_BOT;
        throw sinkError(err, 'GitHub Issue sink', 'resolving the token identity');
      }
    })();
    return identity;
  };

  /** `qtg-spec-12` for an issue of this repository, otherwise a slug of the spec id. */
  const specLabel = (spec: PrdRef): string => {
    const gh = spec.source === 'github' ? spec.id.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/) : null;
    if (gh && gh[1]?.toLowerCase() === owner.toLowerCase() && gh[2]?.toLowerCase() === repo.toLowerCase()) {
      return `qtg-spec-${gh[3]}`;
    }
    return clipLabel(`qtg-spec-${slug(spec.id)}`);
  };
  const priorityLabel = (c: QaCase) => `qa-${c.priority.toLowerCase()}`;
  const toolLabels = (spec: PrdRef, c: QaCase): string[] => [
    GH_CASE_LABEL,
    priorityLabel(c),
    specLabel(spec),
    ...(c.lifecycle === 'obsolete' ? [OBSOLETE_TICKET_LABEL] : []),
  ];
  /** Labels the tool may remove: its own priority / obsolete labels. Never people's labels. */
  const removable = (name: string) => /^qa-p[0-2]$/.test(name) || name === OBSOLETE_TICKET_LABEL;

  const ensured = new Set<string>();
  async function ensureLabels(names: string[]): Promise<void> {
    for (const name of names) {
      if (ensured.has(name)) continue;
      try {
        await withRetry(
          () =>
            octokit.rest.issues.createLabel({
              ...target,
              name,
              color: name.startsWith('qa-p0') ? 'b60205' : 'ededed',
              description: 'qa-ticket-generator',
            }),
          deps.retry,
        );
      } catch (err) {
        // 422 = already exists. Anything else: issue creation still adds the label by name.
        if (statusOf(err) !== 422)
          ctx.logger.debug(`GitHub: could not create label (HTTP ${statusOf(err) ?? '?'}).`);
      }
      ensured.add(name);
    }
  }

  const payloadFor = (c: QaCase, r: RenderedCase, title: string, tool: string): SinkPayload => ({
    v: 1,
    caseId: c.caseId,
    hash: r.hash,
    digest: areaDigest(title, tool),
    case: c,
  });

  const humanOf = (issue: {
    labels: (string | { name?: string })[];
    assignees?: { login: string }[] | null;
  }): HumanFields => {
    const names = issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    const exec = names.find((n) => EXEC_LABEL.test(n));
    const assignee = issue.assignees?.[0]?.login;
    return {
      ...(exec ? { execStatus: exec.slice(3).toLowerCase() } : {}),
      ...(assignee ? { assignee } : {}),
    };
  };

  const getIssue = (number: number, action: string) =>
    call(() => octokit.rest.issues.get({ ...target, issue_number: number }), action).then((r) => r.data);

  async function setToolLabels(number: number, current: string[], wanted: string[]): Promise<void> {
    const add = wanted.filter((l) => !current.includes(l));
    const remove = current.filter((l) => removable(l) && !wanted.includes(l));
    if (add.length) {
      await ensureLabels(add);
      await call(
        () => octokit.rest.issues.addLabels({ ...target, issue_number: number, labels: add }),
        'adding labels',
      );
    }
    for (const name of remove) {
      await call(
        () => octokit.rest.issues.removeLabel({ ...target, issue_number: number, name }),
        'removing a label',
      ).catch((err: unknown) => {
        if (!(err instanceof QtgError && /HTTP 404/.test(err.userMessage))) throw err;
      });
    }
  }

  /** Finds the trusted comment carrying `marker` on an issue (most recent wins). */
  async function findComment(repoTarget: { owner: string; repo: string }, number: number, marker: string) {
    const login = await me();
    const comments = await call(
      () =>
        octokit.paginate(octokit.rest.issues.listComments, {
          ...repoTarget,
          issue_number: number,
          per_page: 100,
        }),
      'listing comments',
    );
    return comments
      .filter((c) => c.user?.login?.toLowerCase() === login && (c.body ?? '').includes(marker))
      .at(-1);
  }

  async function upsertComment(
    repoTarget: { owner: string; repo: string },
    number: number,
    marker: string,
    body: string,
  ): Promise<string | undefined> {
    const existing = await findComment(repoTarget, number, marker);
    if (existing && existing.body === body) return existing.html_url;
    if (existing) {
      const { data } = await call(
        () => octokit.rest.issues.updateComment({ ...repoTarget, comment_id: existing.id, body }),
        'updating a comment',
      );
      return data.html_url;
    }
    const { data } = await call(
      () => octokit.rest.issues.createComment({ ...repoTarget, issue_number: number, body }),
      'creating a comment',
    );
    return data.html_url;
  }

  return {
    kind: 'github-issue',
    isConfigured: () => Boolean(owner && repo),

    async list(spec) {
      const login = await me();
      const issues = await call(
        () =>
          octokit.paginate(octokit.rest.issues.listForRepo, {
            ...target,
            labels: `${GH_CASE_LABEL},${specLabel(spec)}`,
            state: 'all',
            sort: 'created',
            direction: 'asc',
            per_page: 100,
          }),
        'listing case issues',
      );
      const tickets: ExistingCaseTicket[] = [];
      let foreign = 0;
      for (const issue of issues) {
        if (issue.pull_request) continue;
        if (issue.user?.login?.toLowerCase() !== login) {
          foreign++;
          continue;
        }
        const parts = splitBody(issue.body ?? '');
        if (!parts.caseId) continue;
        tickets.push(
          ticketFrom({
            caseId: parts.caseId,
            ticketRef: String(issue.number),
            url: issue.html_url,
            payload: decodePayload(parts.payload, parts.caseId),
            now: areaDigest(issue.title, parts.tool),
            human: humanOf(issue),
          }),
        );
      }
      if (foreign)
        ctx.logger.warn(`GitHub: ignored ${foreign} case issue(s) not created by the tool's identity.`);
      ctx.logger.debug(`GitHub: ${tickets.length} case issue(s) found.`);
      return tickets;
    },

    async create(spec, c, r) {
      const labels = toolLabels(spec, c);
      await ensureLabels(labels);
      const body = composeBody(r.markdown, payloadFor(c, r, r.title, r.markdown), '');
      const { data } = await call(
        () => octokit.rest.issues.create({ ...target, title: r.title, body, labels }),
        'creating a case issue',
      );
      return { ticketRef: String(data.number), url: data.html_url };
    },

    async update(t, c, r) {
      const number = Number(t.ticketRef);
      const issue = await getIssue(number, 'reading a case issue');
      const { tail } = splitBody(issue.body ?? '');
      // Title and tool area only; state, assignees and people's labels are not sent.
      const body = composeBody(r.markdown, payloadFor(c, r, r.title, r.markdown), tail);
      await call(
        () => octokit.rest.issues.update({ ...target, issue_number: number, title: r.title, body }),
        'updating a case issue',
      );
      const current = issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
      const spec = current.find((l) => l.startsWith('qtg-spec-'));
      const wanted = [GH_CASE_LABEL, priorityLabel(c), ...(spec ? [spec] : [])];
      await setToolLabels(number, current, wanted);
    },

    async suggest(t, c, r) {
      const marker = `<!-- ${suggestMarker(c.caseId)} -->`;
      const text = PROPOSED[ctx.language];
      const body = [
        `**${text.heading}**`,
        '',
        text.note,
        '',
        `<details><summary>${text.details}</summary>`,
        '',
        `**${r.title}**`,
        '',
        r.markdown,
        '',
        '</details>',
        '',
        marker,
        `<!-- qtg-suggest-hash:${r.hash} -->`,
      ].join('\n');
      await upsertComment(target, Number(t.ticketRef), marker, body);
    },

    async markObsolete(t) {
      const number = Number(t.ticketRef);
      const issue = await getIssue(number, 'reading a case issue');
      const title = obsoleteTitle(issue.title, ctx.language);
      const parts = splitBody(issue.body ?? '');
      const old = decodePayload(parts.payload, t.caseId);
      const patch: { title: string; body?: string } = { title };
      if (old) {
        // Keep the body as it is; only the title digest changes, so earlier hand edits stay visible.
        const payload: SinkPayload = {
          ...old,
          case: { ...old.case, lifecycle: 'obsolete' },
          digest: { ...old.digest, title: areaDigest(title, '').title },
        };
        patch.body = composeBody(parts.tool, payload, parts.tail);
      }
      await call(
        () => octokit.rest.issues.update({ ...target, issue_number: number, ...patch }),
        'marking a case obsolete',
      );
      const current = issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
      await setToolLabels(number, current, [...current, OBSOLETE_TICKET_LABEL]);
    },

    async publishSummary(spec, summary: CaseSetSummary) {
      const gh = spec.source === 'github' ? spec.id.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/) : null;
      if (!gh?.[1] || !gh[2] || !gh[3]) return {};
      const specTarget = { owner: gh[1], repo: gh[2] };
      const sameRepo =
        gh[1].toLowerCase() === owner.toLowerCase() && gh[2].toLowerCase() === repo.toLowerCase();
      const refFor = (url: string | undefined) => {
        const m = url?.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
        if (!m) return url;
        return sameRepo &&
          m[1]?.toLowerCase() === owner.toLowerCase() &&
          m[2]?.toLowerCase() === repo.toLowerCase()
          ? `#${m[3]}`
          : `${m[1]}/${m[2]}#${m[3]}`;
      };
      const { heading, counts, lines, empty } = summaryLines(summary, refFor);
      const marker = `<!-- ${summaryMarker(spec.id)} -->`;
      const body = [
        `### ${heading}`,
        '',
        counts,
        '',
        ...(lines.length
          ? lines.map((l) => {
              const text = l.ref ? `${l.ref} ${l.text}` : l.text;
              return l.obsolete ? `- [x] ~~${text}~~` : `- [ ] ${text}`;
            })
          : [empty]),
        '',
        marker,
      ].join('\n');
      const url = await upsertComment(specTarget, Number(gh[3]), marker, body);
      return url ? { url } : {};
    },
  };
}
