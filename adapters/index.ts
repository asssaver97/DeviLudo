import type { AgentKind, RuntimeAdapter } from "../lib/agent/types";
import { ClaudeCodeAdapter } from "./claude-code";
import { CodexCliAdapter } from "./codex-cli";

const adapters: Readonly<Record<AgentKind, RuntimeAdapter>> = Object.freeze({
  "claude-code": new ClaudeCodeAdapter(),
  "codex-cli": new CodexCliAdapter(),
});

export function getRuntimeAdapter(agent: AgentKind): RuntimeAdapter {
  return adapters[agent];
}

export { ClaudeCodeAdapter, CodexCliAdapter };
