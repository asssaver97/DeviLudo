import type { AgentRuntimeKind } from "@/lib/product/contracts";
import type { StoredInstanceAgentSettings } from "./repository";

type FetchLike = typeof fetch;

export async function generateProjectName(input: Readonly<{
  concept: string;
  settings: StoredInstanceAgentSettings;
  apiKey: string;
  fetchImpl?: FetchLike;
}>): Promise<string> {
  if (process.env.NODE_ENV === "test" && process.env.DEVILUDO_PROJECT_NAMING_TEST_RESPONSE) {
    return normalizeGeneratedProjectName(process.env.DEVILUDO_PROJECT_NAMING_TEST_RESPONSE);
  }
  const prompt = [
    "为下面的游戏构想生成一个简洁、独特的中文项目名称。",
    "只输出名称，不要引号、解释、标点或 Markdown；长度 2 到 40 个字符。",
    "",
    input.concept,
  ].join("\n");
  const fetchImpl = input.fetchImpl ?? fetch;
  const raw = input.settings.agentRuntime === "CLAUDE_CODE"
    ? await requestClaudeName(fetchImpl, input.settings, input.apiKey, prompt)
    : await requestCodexName(fetchImpl, input.settings.agentRuntime, input.settings.baseUrl, input.apiKey, prompt);
  return normalizeGeneratedProjectName(raw);
}

async function requestClaudeName(
  fetchImpl: FetchLike,
  settings: StoredInstanceAgentSettings,
  apiKey: string,
  prompt: string,
): Promise<string> {
  const model = settings.models?.primary;
  if (!model) throw new Error("Claude Code 主模型尚未配置");
  const response = await fetchImpl(providerEndpoint(settings.baseUrl, "messages"), {
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
  fetchImpl: FetchLike,
  runtime: AgentRuntimeKind,
  baseUrl: string,
  apiKey: string,
  prompt: string,
): Promise<string> {
  if (runtime !== "CODEX_CLI") throw new Error("Agent 运行时配置无效");
  const response = await fetchImpl(providerEndpoint(baseUrl, "responses"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEVILUDO_CODEX_NAMING_MODEL ?? "codex-mini-latest",
      input: prompt,
      max_output_tokens: 80,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Agent 名称生成失败（Provider ${response.status}）`);
  const body = await response.json() as {
    output_text?: unknown;
    output?: readonly { content?: readonly { text?: unknown }[] }[];
  };
  const nested = body.output?.flatMap(item => item.content ?? []).find(item => typeof item.text === "string")?.text;
  const text = typeof body.output_text === "string" ? body.output_text : nested;
  if (typeof text !== "string") throw new Error("Agent 未返回有效项目名称");
  return text;
}

function providerEndpoint(baseUrl: string, resource: "messages" | "responses"): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/${resource}`.replace(/\/{2,}/g, "/");
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
