/** Keeps docs/examples in sync with action.yml, the spec and the PRD ref parser. Owner: qa-work-session-a. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { extractPrdRefs } from '../../src/context/prd/refs';
import { parseRepoConfig } from '../../src/core/config';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const yamlOf = <T = Record<string, unknown>>(path: string) => parse(read(path)) as T;

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<
    string,
    { if?: string; concurrency?: { group?: string; 'cancel-in-progress'?: unknown }; steps: Step[] }
  >;
}

const ACTION = 'ggreing/qa-ticket-generator@';
const V3 = 'docs/examples/workflow-v3.yml';
const WORKFLOWS = ['docs/examples/workflow.yml', 'docs/examples/workflow-fork-opt-in.yml', V3];
/** Minimal permissions per example; the v3 flow writes case issues, so it needs issues: write. */
const PERMISSIONS: Record<string, Record<string, string>> = {
  'docs/examples/workflow.yml': { contents: 'read', 'pull-requests': 'write', issues: 'read' },
  'docs/examples/workflow-fork-opt-in.yml': { contents: 'read', 'pull-requests': 'write', issues: 'read' },
  [V3]: { contents: 'read', 'pull-requests': 'write', issues: 'write' },
};

const action = yamlOf<{ inputs: Record<string, { required?: boolean; default?: string }> }>('action.yml');
const inputNames = new Set(Object.keys(action.inputs));
const requiredInputs = Object.entries(action.inputs)
  .filter(([, v]) => v.required === true)
  .map(([k]) => k);
const triggerLabel = action.inputs['trigger-label']?.default;

const steps = (wf: Workflow) => Object.values(wf.jobs).flatMap((j) => j.steps);
const actionSteps = (wf: Workflow) => steps(wf).filter((s) => s.uses?.startsWith(ACTION));

/** First ```yaml block after the given SPEC heading. */
function specYaml(heading: string): unknown {
  const spec = read('docs/SPEC.ko.md');
  const at = spec.indexOf(heading);
  expect(at, `SPEC heading ${heading}`).toBeGreaterThanOrEqual(0);
  const block = spec.slice(at).match(/```yaml\n([\s\S]*?)\n```/);
  expect(block?.[1], `yaml block under ${heading}`).toBeDefined();
  return parse(block?.[1] ?? '');
}

describe('docs/examples workflows', () => {
  it.each(WORKFLOWS)('DOC %s uses only inputs declared in action.yml', (path) => {
    const wf = yamlOf<Workflow>(path);
    const uses = actionSteps(wf);
    expect(uses.length).toBeGreaterThan(0);
    for (const step of uses) {
      const keys = Object.keys(step.with ?? {});
      expect(keys.filter((k) => !inputNames.has(k))).toEqual([]);
      for (const req of requiredInputs) expect(keys).toContain(req);
    }
  });

  it.each(WORKFLOWS)('DOC §11 %s never checks out or runs PR code', (path) => {
    const wf = yamlOf<Workflow>(path);
    for (const step of steps(wf)) {
      expect(step.uses ?? '').not.toMatch(/^actions\/checkout@/);
      expect(step.run).toBeUndefined();
    }
    expect(wf.permissions).toEqual(PERMISSIONS[path]);
  });

  it('DOC v3 §2 example plans from a labelled issue or a manual spec, verifies PRs and keeps the case files', () => {
    const wf = yamlOf<Workflow>(V3);
    expect(wf.on).toEqual({
      issues: { types: ['labeled'] },
      pull_request: { types: ['labeled', 'synchronize', 'opened', 'reopened'] },
      workflow_dispatch: {
        inputs: {
          spec: expect.objectContaining({ required: false }),
          'pr-number': expect.objectContaining({ required: false }),
        },
      },
    });
    const job = wf.jobs.qa;
    expect(job?.if).toContain(`github.event.label.name == '${action.inputs['plan-label']?.default}'`);
    expect(job?.if).toContain(`'${triggerLabel}'`);
    // A run skipped by `if` (any other label on the spec issue) must not cancel a running plan.
    expect(wf.concurrency).toBeUndefined();
    expect(job?.concurrency?.group).toMatch(/github\.event\.issue\.number/);
    expect(job?.concurrency?.['cancel-in-progress']).toMatch(
      /^\$\{\{ github\.event_name == 'pull_request' \}\}$/,
    );
    const qa = actionSteps(wf)[0] as Step & { id?: string };
    expect(qa.id).toBe('qa');
    expect(String(qa.with?.sinks).split(',')).toContain('file');
    const upload = steps(wf).find((s) => s.uses?.startsWith('actions/upload-artifact@')) as Step & {
      if?: string;
    };
    expect(upload?.if).toBe("steps.qa.outputs.cases-dir != ''");
    // Same pin as our release workflow (full SHA, version in the comment).
    const releasePin = read('.github/workflows/release.yml').match(
      /actions\/upload-artifact@([0-9a-f]{40}) # (v[\d.]+)/,
    );
    expect(releasePin).not.toBeNull();
    expect(upload?.uses).toBe(`actions/upload-artifact@${releasePin?.[1]}`);
    expect(read(V3)).toContain(`${upload?.uses} # ${releasePin?.[2]}`);
    expect(upload?.with?.path).toMatch(/^\$\{\{ steps\.qa\.outputs\.cases-dir \}\}$/);
    // The upload step only ships files the action wrote; nothing else runs.
    expect(steps(wf)).toHaveLength(2);
  });

  it('DOC §4.1 quickstart matches the spec and the default trigger label', () => {
    const wf = yamlOf<Workflow>('docs/examples/workflow.yml');
    expect(wf).toEqual(specYaml('### 4.1'));
    expect(wf.jobs.qa?.if).toContain(`'${triggerLabel}'`);
  });

  it('DOC §11 fork opt-in runs on labeled pull_request_target only, for fork PRs, in one step', () => {
    const wf = yamlOf<Workflow>('docs/examples/workflow-fork-opt-in.yml');
    expect(wf.on).toEqual({ pull_request_target: { types: ['labeled'] } });
    const job = wf.jobs.qa;
    expect(job?.steps).toHaveLength(1);
    expect(job?.if).toContain(`github.event.label.name == '${triggerLabel}'`);
    expect(job?.if).toContain('github.event.pull_request.head.repo.full_name != github.repository');
    expect(actionSteps(wf)[0]?.with?.['allow-fork-prs']).toBe('true');
    expect(read('docs/examples/workflow-fork-opt-in.yml').split('\n')[0]).toMatch(/SECURITY WARNING/);
    expect(read('docs/examples/workflow-fork-opt-in.yml')).toMatch(/NEVER use actions\/checkout/);
  });
});

describe('docs/examples repo config', () => {
  it('DOC §4.3 example parses with the real repo-config schema', () => {
    const cfg = parseRepoConfig(read('docs/examples/qa-ticket-generator.yml'));
    expect(cfg.prd).toEqual({
      jiraProjectKeys: ['PROJ', 'WEB'],
      jiraAcceptanceCriteriaField: 'customfield_10042',
      maxDocuments: 5,
    });
    expect(cfg.prompt.glossary).toHaveLength(1);
  });

  it('DOC §4.3 example matches the spec (prompt text translated to English)', () => {
    const example = yamlOf('docs/examples/qa-ticket-generator.yml');
    const spec = specYaml('### 4.3') as Record<string, unknown>;
    const { prompt: examplePrompt, ...exampleRest } = example;
    const { prompt: specPrompt, ...specRest } = spec;
    expect(exampleRest).toEqual(specRest);
    expect(Object.keys(examplePrompt as object)).toEqual(Object.keys(specPrompt as object));
  });
});

describe('docs/examples/pull_request_template.md', () => {
  const opts = { defaultOwner: 'acme', defaultRepo: 'shop', jiraProjectKeys: ['PROJ'], maxDocuments: 5 };

  it('PRD-01 the template examples sit in HTML comments, so the parser ignores them', () => {
    const template = read('docs/examples/pull_request_template.md');
    expect(template).toMatch(/Closes #123/);
    expect(template).toMatch(/atlassian\.net\/browse\/PROJ-123/);
    expect(extractPrdRefs(template, opts)).toEqual([]);
  });

  it('PRD-01 links filled into the template are picked up', () => {
    const filled = read('docs/examples/pull_request_template.md').replace(
      /\n-\n/,
      '\n- Closes #9\n- PROJ-4\n',
    );
    expect(extractPrdRefs(filled, opts).map((r) => r.id)).toEqual(['acme/shop#9', 'PROJ-4']);
  });
});

describe('.github community files', () => {
  it('DOC dependabot updates npm and github-actions weekly', () => {
    const cfg = yamlOf<{
      version: number;
      updates: { 'package-ecosystem': string; schedule: { interval: string } }[];
    }>('.github/dependabot.yml');
    expect(cfg.version).toBe(2);
    expect(cfg.updates.map((u) => [u['package-ecosystem'], u.schedule.interval])).toEqual([
      ['npm', 'weekly'],
      ['github-actions', 'weekly'],
    ]);
  });

  it.each(['bug_report.yml', 'feature_request.yml'])('DOC issue form %s is valid', (file) => {
    const form = yamlOf<{ name: string; body: { type: string; id?: string }[] }>(
      `.github/ISSUE_TEMPLATE/${file}`,
    );
    expect(form.name).toBeTruthy();
    const ids = form.body.filter((b) => b.type !== 'markdown').map((b) => b.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('DOC issue chooser disables blank issues and links private security reports', () => {
    const cfg = yamlOf<{ blank_issues_enabled: boolean; contact_links: { url: string }[] }>(
      '.github/ISSUE_TEMPLATE/config.yml',
    );
    expect(cfg.blank_issues_enabled).toBe(false);
    expect(cfg.contact_links.map((l) => l.url)).toContain(
      'https://github.com/ggreing/qa-ticket-generator/security/advisories/new',
    );
  });

  it('DOC community docs exist and contain no e-mail addresses', () => {
    for (const path of ['CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) {
      expect(read(path).length).toBeGreaterThan(500);
      expect(read(path)).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
    expect(read('CONTRIBUTING.md')).toContain('docs/DEVELOPMENT.md');
    expect(read('CODE_OF_CONDUCT.md')).toContain('version 2.1');
  });
});
