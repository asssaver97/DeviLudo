import type { StoredInstanceAgentSettings } from "./repository";
import { runCodexPrompt } from "./codex-cli";
import { resolveAgentModel } from "./agent-settings";
import {
  parseResponseLanguage,
  responseLanguageInstruction,
  type ResponseLanguage,
} from "@/lib/product/response-language";

type FetchLike = typeof fetch;

export async function generateProjectName(input: Readonly<{
  concept: string;
  settings: StoredInstanceAgentSettings;
  apiKey: string;
  responseLanguage?: ResponseLanguage;
  fetchImpl?: FetchLike;
}>): Promise<string> {
  if (process.env.NODE_ENV === "test" && process.env.DEVILUDO_PROJECT_NAMING_TEST_RESPONSE) {
    return normalizeGeneratedProjectName(process.env.DEVILUDO_PROJECT_NAMING_TEST_RESPONSE);
  }
  const language = parseResponseLanguage(input.responseLanguage);
  const languageInstruction = responseLanguageInstruction(language);
  const prompt = [
    "Generate a concise, distinctive project name for the game concept below.",
    "Return only the name, with no quotation marks, explanation, punctuation, or Markdown. Use 2 to 40 characters.",
    ...(languageInstruction ? [languageInstruction] : []),
    "",
    input.concept,
  ].join("\n");
  const fetchImpl = input.fetchImpl ?? fetch;
  const raw = input.settings.agentRuntime === "CLAUDE_CODE"
    ? await requestClaudeName(fetchImpl, input.settings, input.apiKey, prompt)
    : await requestCodexName(input.settings, input.apiKey, prompt);
  return normalizeGeneratedProjectName(raw);
}

async function requestClaudeName(
  fetchImpl: FetchLike,
  settings: StoredInstanceAgentSettings,
  apiKey: string,
  prompt: string,
): Promise<string> {
  const model = resolveAgentModel(settings.primaryModel, settings.modelOverrides, "design");
  const response = await fetchImpl(messagesEndpoint(settings.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Agent 名称生成失败（Provider ${response.status}）`);
  const body = await response.json() as { content?: readonly { type?: unknown; text?: unknown }[] };
  const text = body.content?.find(item => item.type === "text" && typeof item.text === "string")?.text;
  if (typeof text !== "string") throw new Error("Agent 未返回有效项目名称");
  return text;
}

async function requestCodexName(
  settings: StoredInstanceAgentSettings,
  authJson: string,
  prompt: string,
): Promise<string> {
  if (settings.agentRuntime !== "CODEX_CLI") throw new Error("Codex CLI 模型尚未配置");
  const model = resolveAgentModel(settings.primaryModel, settings.modelOverrides, "design");
  return runCodexPrompt({ authJson, model, prompt, timeoutMs: 30_000 });
}

function messagesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/messages`.replace(/\/{2,}/g, "/");
  return url.href;
}

export function normalizeGeneratedProjectName(value: string): string {
  const normalized = value
    .trim()
    .replace(/^[`'"“”‘’《》]+|[`'"“”‘’《》]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 2 || normalized.length > 40 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Agent 生成的项目名称无效");
  }
  return normalized;
}
