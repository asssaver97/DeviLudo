export type ResponseLanguage = "en" | "zh";

export const DEFAULT_RESPONSE_LANGUAGE: ResponseLanguage = "en";

export function parseResponseLanguage(value: unknown): ResponseLanguage {
  return value === "zh" ? "zh" : DEFAULT_RESPONSE_LANGUAGE;
}

/**
 * Agent prompts are authored in English. Chinese is an explicit per-project
 * response preference captured from the UI and frozen into asynchronous work.
 */
export function responseLanguageInstruction(language: ResponseLanguage): string | null {
  return language === "zh"
    ? "请用中文回答。Keep code, file paths, schema names, JSON property names, and enum values unchanged."
    : null;
}
