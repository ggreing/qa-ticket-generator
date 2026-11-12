/** Keeps the four READMEs in sync with action.yml and with each other. Owner: qa-work-session-a. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

const READMES = ['README.md', 'docs/README.ko.md', 'docs/README.ja.md', 'docs/README.zh-CN.md'] as const;

const action = parse(read('action.yml')) as {
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
};

/** Expected `name | required | default` rows, straight from action.yml. */
const expectedInputs = Object.entries(action.inputs)
  .map(([name, v]) => `${name} | ${v.required === true ? 'required' : ''} | ${v.default ?? '—'}`)
  .sort();

/** Table rows between `<!-- <name>:start -->` and `<!-- <name>:end -->`, split into trimmed cells. */
function tableRows(markdown: string, name: string): string[][] {
  const block = markdown.match(new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`));
  expect(block, `${name} markers`).not.toBeNull();
  const rows = (block?.[1] ?? '')
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
  return rows.slice(2); // header + separator
}

const unquote = (cell: string) => cell.replace(/^`(.*)`$/, '$1');

/** Relative link targets of Markdown links/images and HTML src/href attributes. */
function relativeLinks(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '');
  const targets = [
    ...[...withoutCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1] ?? ''),
    ...[...withoutCode.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? ''),
  ];
  return targets.filter((t) => t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('#'));
}

describe.each(READMES)('%s', (path) => {
  const md = read(path);

  it('DOC Inputs table matches action.yml names, required flags and defaults exactly', () => {
    const rows = tableRows(md, 'inputs').map(([name = '', required = '', def = '']) => {
      const req = required === '' ? '' : 'required';
      return `${unquote(name)} | ${req} | ${unquote(def)}`;
    });
    expect(rows.sort()).toEqual(expectedInputs);
  });

  it('DOC Outputs table matches action.yml outputs', () => {
    const names = tableRows(md, 'outputs').map(([name = '']) => unquote(name));
    expect(names.sort()).toEqual(Object.keys(action.outputs).sort());
  });

  it('DOC relative links and images exist', () => {
    const base = new URL(path, ROOT);
    const links = relativeLinks(md);
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      const target = new URL(decodeURI(link.split('#')[0] ?? ''), base);
      expect(existsSync(target), `${path} → ${link}`).toBe(true);
    }
    expect(
      links.some(
        (l) => l.endsWith('docs/diagrams/architecture.png') || l.endsWith('diagrams/architecture.png'),
      ),
    ).toBe(true);
  });

  it('DOC links to every language and keeps the pre-v0.1 warning', () => {
    const top = md.split('\n').slice(0, 5).join('\n');
    for (const lang of ['English', '한국어', '日本語', '简体中文']) expect(top).toContain(lang);
    expect(md).toContain('🚧');
    expect(md).toContain('pre-v0.1');
  });

  it('DOC contains no e-mail addresses', () => {
    expect(md).not.toMatch(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i);
  });
});

describe('README translations', () => {
  // Headings inside fenced blocks (the PR-comment mock-up) are not sections.
  const prose = (md: string) => md.replace(/```[\s\S]*?```/g, '').split('\n');
  const headings = (md: string) => prose(md).filter((l) => /^## /.test(l));
  const subHeadings = (md: string) => prose(md).filter((l) => /^### /.test(l));

  it('DOC all four READMEs have the same number of ## and ### sections', () => {
    const [en, ...others] = READMES.map(read);
    for (const [i, md] of others.entries()) {
      expect(headings(md).length, READMES[i + 1]).toBe(headings(en ?? '').length);
      expect(subHeadings(md).length, READMES[i + 1]).toBe(subHeadings(en ?? '').length);
    }
  });

  it('DOC code blocks are identical except for comments and prose inside the mock-up', () => {
    const blocks = (md: string) =>
      [...md.matchAll(/```(\w*)\n([\s\S]*?)```/g)]
        .filter((m) => m[1] !== 'markdown')
        .map((m) => (m[2] ?? '').replace(/#.*$/gm, '').replace(/\s+$/gm, ''));
    const [en, ...others] = READMES.map(read);
    for (const md of others) expect(blocks(md)).toEqual(blocks(en ?? ''));
  });

  it('DOC no README still carries the pre-preprocessing status note or "in progress" markers', () => {
    // Preprocessing shipped (main 69f6bfb); these must not come back without a matching feature gap.
    const leftovers =
      /_\((?:in progress|진행 중|実装中|开发中)\)_|Still in progress|아직 진행 중인 것|実装済み:|仍在开发/;
    for (const [i, md] of READMES.map(read).entries()) expect(md, READMES[i]).not.toMatch(leftovers);
  });
});
