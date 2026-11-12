/**
 * AST language ids (PRE-06) and the file extensions they cover. Shared by the GitHub reader
 * (which head contents to fetch, CTX-03) and the preprocess engine (which grammar to use).
 * OWNERSHIP: control session only.
 */
export const AST_LANGUAGE_EXTENSIONS = {
  typescript: ['.ts', '.mts', '.cts'],
  tsx: ['.tsx'],
  javascript: ['.js', '.mjs', '.cjs', '.jsx'],
  python: ['.py'],
  java: ['.java'],
  go: ['.go'],
} as const satisfies Record<string, readonly string[]>;

export type AstLanguage = keyof typeof AST_LANGUAGE_EXTENSIONS;

/** Extensions for the enabled languages, e.g. for `createGitHubReader({ astExtensions })`. */
export function astExtensionsFor(languages: readonly string[]): string[] {
  return languages.flatMap((l) => AST_LANGUAGE_EXTENSIONS[l as AstLanguage] ?? []);
}

/** AST language for a path, or null when unsupported / disabled. `.d.ts` files are ignored. */
export function astLanguageForPath(path: string, enabled: readonly string[]): AstLanguage | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.d.ts')) return null;
  for (const lang of enabled) {
    const exts: readonly string[] = AST_LANGUAGE_EXTENSIONS[lang as AstLanguage] ?? [];
    if (exts.some((e) => lower.endsWith(e))) return lang as AstLanguage;
  }
  return null;
}
