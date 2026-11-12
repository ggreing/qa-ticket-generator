/** Output-language names used in prompts (LLM-09). Owner: qa-work-session-c(fable). */
import type { Language } from '../../core/contracts';

export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: 'English',
  ko: 'Korean (한국어)',
  ja: 'Japanese (日本語)',
  'zh-CN': 'Simplified Chinese (简体中文)',
};
