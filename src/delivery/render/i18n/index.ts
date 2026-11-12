/** UI strings for rendered output, one table per language (ADR-0010). Owner: qa-work-session-c(fable). */
import type { Language } from '../../../core/contracts';
import { en } from './en';
import { ja } from './ja';
import { ko } from './ko';
import type { Strings } from './types';
import { zhCN } from './zh-CN';

export type { Strings } from './types';

const TABLES: Readonly<Record<Language, Strings>> = { en, ko, ja, 'zh-CN': zhCN };

/** Returns the string table for `language` (English when unknown). */
export function strings(language: Language): Strings {
  return TABLES[language] ?? en;
}
