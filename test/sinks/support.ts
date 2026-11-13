/**
 * Test support for the case sinks: a stand-in for session b's renderCase that follows the rules
 * b agreed on (labelled title, `###` headings, `-`/`1.` lists, escapes, hash =
 * sha256(title + "\n" + markdown)). Owner: qa-work-session-a.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { QaCase, RenderedCase, SinkContext } from '../../src/core/cases';
import type { Language, PrdRef } from '../../src/core/contracts';
import { silentLogger } from '../helpers/fakes';

const TECH: Record<string, string> = { boundary: '경계값', happy_path: '정상 흐름', permission: '권한' };
const LABEL: Record<Language, string> = {
  en: 'Obsolete',
  ko: '해당 없음',
  ja: '対象外',
  'zh-CN': '不再适用',
};

export function baseCase(over: Partial<QaCase> = {}): QaCase {
  const fx = JSON.parse(
    readFileSync(new URL('../../fixtures/sinks/case-coupon.json', import.meta.url), 'utf8'),
  );
  delete fx._comment;
  return { ...(fx as QaCase), ...over };
}

const esc = (s: string) => s.replace(/([\\`*_[\]<>#|~&])/g, '\\$1');

export function render(c: QaCase, language: Language = 'ko'): RenderedCase {
  const tech = TECH[c.technique] ?? c.technique;
  const name = c.title;
  const title = `${c.lifecycle === 'obsolete' ? `[${LABEL[language]}]` : ''}[${c.priority}][${tech}] ${name}`;
  const markdown = [
    '### 전제',
    ...c.preconditions.map((p) => `- ${esc(p)}`),
    '',
    '### 데이터',
    ...c.testData.map((d) => `- ${esc(d)}`),
    '',
    '### 단계',
    ...c.steps.map((s, i) => `${i + 1}. ${esc(s)}`),
    '',
    '### 기대 결과',
    ...c.expected.map((e, i) => (i === 0 ? `**${esc(e)}**` : esc(e))),
    '',
    `놓치기 쉬운 이유: ${esc(c.whyEasyToMiss)}`,
  ].join('\n');
  return {
    title,
    markdown,
    fields: {
      case_id: c.caseId,
      spec_ref: c.specRef,
      title,
      name,
      priority: c.priority,
      technique: c.technique,
      technique_label: tech,
      ac: c.acLabels.join(', '),
      lifecycle: c.lifecycle,
    },
    hash: createHash('sha256').update(`${title}\n${markdown}`).digest('hex'),
  };
}

export function sinkCtx(
  language: Language = 'ko',
): SinkContext & { logger: ReturnType<typeof silentLogger> } {
  return { logger: silentLogger(), language };
}

export const jiraSpec: PrdRef = {
  source: 'jira',
  id: 'PROJ-123',
  raw: 'PROJ-123',
  url: 'https://acme.atlassian.net/browse/PROJ-123',
};
export const githubSpec: PrdRef = {
  source: 'github',
  id: 'acme/shop#12',
  raw: '#12',
  url: 'https://github.com/acme/shop/issues/12',
};
export const notionSpec: PrdRef = {
  source: 'notion',
  id: '0123456789abcdef0123456789abcdef',
  raw: 'https://www.notion.so/x',
};

export const signal = () => new AbortController().signal;
export const instant = { sleep: async () => undefined };
