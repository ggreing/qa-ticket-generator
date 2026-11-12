import { describe, expect, it, vi } from 'vitest';
import { createSummaryDeliverer, type SummarySink } from '../../src/delivery/summary';
import { finalReport } from './support';

function sink(overrides: Partial<SummarySink> = {}) {
  const written: { markdown?: string; json?: string } = {};
  const s: SummarySink = {
    writeMarkdown: vi.fn(async (markdown: string) => {
      written.markdown = markdown;
    }),
    writeJson: vi.fn(async (json: string) => {
      written.json = json;
      return '/tmp/runner/report.json';
    }),
    ...overrides,
  };
  return { sink: s, written };
}

describe('createSummaryDeliverer (DLV-07)', () => {
  it('DLV-07 writes the full Markdown report and the whole FinalReport as report.json, returning its path', async () => {
    const { sink: s, written } = sink();
    const final = finalReport();
    const deliverer = createSummaryDeliverer(s);
    const res = await deliverer.deliver(final, { v: 1 });

    expect(deliverer.channel).toBe('summary');
    expect(res).toEqual({ channel: 'summary', ok: true, url: '/tmp/runner/report.json' });
    expect(written.markdown).toContain('## 🧪 AI QA — ');
    expect(written.markdown).toContain('Skipped files (3)');
    expect(written.markdown).toContain('<code>package-lock.json</code> — noise');
    expect(JSON.parse(written.json ?? '')).toEqual(final);
    expect(written.json?.endsWith('}\n')).toBe(true);
  });

  it('DLV-07 writes skipped and failed runs too, with the skip reason', async () => {
    const { sink: s, written } = sink({ writeJson: vi.fn(async () => null) });
    const final = finalReport(
      { status: 'skipped', report: null, skipReason: 'no_logic_change' },
      { calls: 0 },
    );
    const res = await createSummaryDeliverer(s).deliver(final, { v: 1 });
    expect(res).toEqual({ channel: 'summary', ok: true });
    expect(written.markdown).toContain('Analysis was skipped: <code>no&#95;logic&#95;change</code>');
  });

  it('DLV-08 never throws: a sink failure becomes a warning and the other file is still written', async () => {
    const failingMarkdown = sink({
      writeMarkdown: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const a = await createSummaryDeliverer(failingMarkdown.sink).deliver(finalReport(), { v: 1 });
    expect(a).toEqual({
      channel: 'summary',
      ok: false,
      url: '/tmp/runner/report.json',
      warning: { code: 'other', message: 'Could not write the job summary or report.json.' },
    });

    const failingJson = sink({
      writeJson: vi.fn(async () => {
        throw new Error('ENOSPC');
      }),
    });
    const b = await createSummaryDeliverer(failingJson.sink).deliver(finalReport(), { v: 1 });
    expect(b.ok).toBe(false);
    expect(b.url).toBeUndefined();
    expect(failingJson.written.markdown).toContain('🧪 AI QA');
  });
});
