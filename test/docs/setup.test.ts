/** Keeps docs/setup in sync with the Jira and Notion case sinks. Owner: qa-work-session-a. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CASE_LABEL, OBSOLETE_LABEL, OBSOLETE_TICKET_LABEL } from '../../src/sinks/common';
import { PAYLOAD_TITLE, PRIORITY_NAME } from '../../src/sinks/jira';
import { PROP } from '../../src/sinks/notion';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const action = parse(read('action.yml')) as { inputs: Record<string, { default?: string }> };

/** Backticked names in the first column of the Markdown table under the given heading. */
function tableColumns(md: string, heading: string): string[] {
  const at = md.indexOf(heading);
  expect(at, heading).toBeGreaterThanOrEqual(0);
  const rows = md
    .slice(at)
    .split('\n')
    .filter((l) => l.startsWith('| `'));
  return rows.map((l) => l.match(/^\| `([^`]+)`/)?.[1] ?? '');
}

/** `with:` keys of every yaml block, so the docs only name real inputs. */
function yamlKeys(md: string): string[] {
  return [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].flatMap((m) => Object.keys(parse(m[1] ?? '') ?? {}));
}

describe('docs/setup/notion-qa-database.md', () => {
  const md = read('docs/setup/notion-qa-database.md');

  it('DOC SPEC v3 Q1 lists exactly the columns the Notion sink reads and writes', () => {
    expect(tableColumns(md, '## 2. Columns').sort()).toEqual(Object.values(PROP).sort());
  });

  it('DOC names only real action inputs and the obsolete prefixes the sink writes', () => {
    expect(yamlKeys(md).filter((k) => !(k in action.inputs))).toEqual([]);
    expect(md).toContain(`[${OBSOLETE_LABEL.en}]`);
    expect(md).toContain(`[${OBSOLETE_LABEL.ko}]`);
  });
});

describe('docs/setup/jira-subtasks.md', () => {
  const md = read('docs/setup/jira-subtasks.md');

  it('DOC states the labels, priority mapping and payload section the Jira sink uses', () => {
    expect(md).toContain(`\`${CASE_LABEL}\``);
    expect(md).toContain(`\`${OBSOLETE_TICKET_LABEL}\``);
    expect(md).toContain(`"${PAYLOAD_TITLE}"`);
    for (const [p, name] of Object.entries(PRIORITY_NAME)) expect(md).toContain(`${p} is ${name}`);
    expect(md).toContain(`labels = ${CASE_LABEL}`);
  });

  it('DOC names only real action inputs, with the default sub-task type', () => {
    expect(yamlKeys(md).filter((k) => !(k in action.inputs))).toEqual([]);
    expect(md).toContain(`jira-subtask-type: ${action.inputs['jira-subtask-type']?.default}`);
  });
});
