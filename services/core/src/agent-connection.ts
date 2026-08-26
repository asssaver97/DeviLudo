import { resolveAgentModel } from "./agent-settings";
import { runCodexPrompt, type CodexPromptRunner } from "./codex-cli";
import type { AgentModelOverrides, AgentRuntimeKind } from "@/lib/product/contracts";

const PROBE = "DEVILUDO_CONNECTION_OK";

export async function testAgentConnection(
  settings: Readonly<{
    agentRuntime: AgentRuntimeKind;
    baseUrl: string;
    primaryModel: string;
    modelOverrides: AgentModelOverrides;
  }>,
  credential: string,
  fetchImpl: typeof fetch = fetch,
  codexRunner: CodexPromptRunner = runCodexPrompt,
): Promise<void> {
  const model = resolveAgentModel(settings.primaryModel, settings.modelOverrides, "design");
  const prompt = `Reply with exactly ${PROBE} and nothing else.`;
  const output = settings.agentRuntime === "CODEX_CLI"
    ? await codexRunner({
        baseUrl: settings.baseUrl,
        credential,
        model,
        prompt,
        reasoningEffort: "low",
        timeoutMs: 45_000,
      })
    : await probeClaude(fetchImpl, settings.baseUrl, credential, model, prompt);
  if (output.trim() !== PROBE) throw new Error("Agent Provider returned an unexpected connection-test response");
}

async function probeClaude(
  fetchImpl: typeof fetch,
  baseUrl: string,
  credential: string,
  model: string,
  prompt: string,
): Promise<string> {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/messages`.replace(/\/{2,}/g, "/");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": credential,
    },
    body: JSON.stringify({ model, max_tokens: 64, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Agent Provider connection test failed (${response.status})`);
  const body = await response.json() as { content?: readonly { type?: unknown; text?: unknown }[] };
  const text = body.content?.find(item => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Agent Provider connection test returned no text");
  return text;
}
