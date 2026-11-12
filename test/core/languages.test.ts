import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/core/config';
import { astExtensionsFor, astLanguageForPath } from '../../src/core/languages';

describe('AST language mapping', () => {
  it('maps every default language to extensions', () => {
    expect(astExtensionsFor(DEFAULTS.astLanguages)).toEqual([
      '.ts',
      '.mts',
      '.cts',
      '.tsx',
      '.js',
      '.mjs',
      '.cjs',
      '.jsx',
      '.py',
      '.java',
      '.go',
    ]);
    expect(astExtensionsFor(['python', 'cobol'])).toEqual(['.py']);
  });

  it('resolves a path to its language, ignoring .d.ts and disabled languages', () => {
    const all = DEFAULTS.astLanguages;
    expect(astLanguageForPath('src/App.TSX', all)).toBe('tsx');
    expect(astLanguageForPath('src/a.ts', all)).toBe('typescript');
    expect(astLanguageForPath('types/index.d.ts', all)).toBeNull();
    expect(astLanguageForPath('main.go', ['python'])).toBeNull();
    expect(astLanguageForPath('README.md', all)).toBeNull();
  });
});
