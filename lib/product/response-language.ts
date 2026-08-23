export type ResponseLanguage = "en" | "zh";

export const DEFAULT_RESPONSE_LANGUAGE: ResponseLanguage = "en";

export function parseResponseLanguage(value: unknown): ResponseLanguage {
  return value === "zh" ? "zh" : DEFAULT_RESPONSE_LANGUAGE;
}

/** The active UI locale is frozen into every content-generating Agent task. */
export function responseLanguageInstruction(language: ResponseLanguage): string {
  return language === "zh"
    ? "所有自然语言输出必须使用中文，包括项目名称、回复、项目说明、需求、计划、摘要和玩家可见文本。Keep code, file paths, schema names, JSON property names, and enum values unchanged."
    : "All natural-language output must be in English, including project names, replies, project documents, requirements, plans, summaries, and player-facing text. Keep code, file paths, schema names, JSON property names, and enum values unchanged.";
}
