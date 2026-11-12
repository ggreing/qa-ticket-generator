import { describe, expect, it } from 'vitest';
import type { Language } from '../../src/core/contracts';
import { strings } from '../../src/delivery/render/i18n';

const LANGUAGES: Language[] = ['en', 'ko', 'ja', 'zh-CN'];

/** Flattens a string table to `path → rendered string`, calling formatter functions with sample values. */
function flat(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'string') return { [path]: value };
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => string;
    return { [path]: fn.length === 2 ? fn('31.2K', '5.8K') : fn(7) };
  }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (acc, [key, child]) => Object.assign(acc, flat(child, path ? `${path}.${key}` : key)),
    {},
  );
}

describe('UI string tables (ADR-0010)', () => {
  const english = flat(strings('en'));

  it.each(LANGUAGES)('ADR-0010 %s defines every string the English table defines, none empty', (language) => {
    const table = flat(strings(language));
    expect(Object.keys(table).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(table)) {
      expect(text.trim(), key).not.toBe('');
    }
  });

  it.each(LANGUAGES)('ADR-0010 %s formatters include the values they are given', (language) => {
    const t = strings(language);
    expect(t.omittedScenarios(7)).toContain('7');
    expect(t.omittedFindings(7)).toContain('7');
    expect(t.footer.tokens('31.2K', '5.8K')).toMatch(/31\.2K.*5\.8K/);
    expect(t.footer.cache('20.0K', '10.0K')).toMatch(/20\.0K.*10\.0K/);
    expect(t.footer.calls(7)).toContain('7');
    expect(t.footer.filesSkipped(7)).toContain('7');
    expect(t.footer.redactions(7)).toContain('7');
    // DLV-03: the notice must say where the full report is.
    for (const notice of [t.omittedScenarios(1), t.omittedFindings(1), t.truncated]) {
      expect(notice).toContain('Job Summary');
      expect(notice).toContain('report.json');
    }
  });

  it.each(['ko', 'ja', 'zh-CN'] as Language[])('ADR-0010 %s is actually translated', (language) => {
    const table = flat(strings(language));
    const same = Object.keys(english).filter((key) => table[key] === english[key]);
    expect(same).toEqual([]);
  });

  it('ADR-0010 falls back to English for an unknown language code', () => {
    expect(strings('fr' as Language)).toBe(strings('en'));
  });
});
