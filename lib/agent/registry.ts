import type { AgentKind } from "./types";

export interface AgentRegistryEntry {
  readonly agent: AgentKind;
  readonly displayName: string;
  readonly vendor: string;
  readonly adapter: string;
  readonly officialSource: string;
  readonly supportedWorkerPlatforms: readonly string[];
  readonly capabilities: readonly string[];
  readonly selfUpdateAllowed: false;
}

export const DEFAULT_AGENT: AgentKind = "claude-code";

export const AGENT_REGISTRY: Readonly<Record<AgentKind, AgentRegistryEntry>> =
  Object.freeze({
    "claude-code": Object.freeze({
      agent: "claude-code",
      displayName: "Claude Code",
      vendor: "Anthropic",
      adapter: "claude-code-v1",
      officialSource: "https://code.claude.com/docs/en/installation",
      supportedWorkerPlatforms: Object.freeze(["linux/amd64", "linux/arm64"]),
      capabilities: Object.freeze([
        "planning",
        "code-editing",
        "tool-events",
        "budget-limit",
        "cancellation",
      ]),
      selfUpdateAllowed: false,
    }),
    "codex-cli": Object.freeze({
      agent: "codex-cli",
      displayName: "Codex CLI",
      vendor: "OpenAI",
      adapter: "codex-cli-v1",
      officialSource: "https://developers.openai.com/codex/cli",
      supportedWorkerPlatforms: Object.freeze(["linux/amd64", "linux/arm64"]),
      capabilities: Object.freeze([
        "planning",
        "code-editing",
        "structured-output",
        "tool-events",
        "cancellation",
      ]),
      selfUpdateAllowed: false,
    }),
  });
