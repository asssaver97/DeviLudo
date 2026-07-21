import type { AgentKind } from "./types";

/** Exact Adapter versions compiled into this control-plane release. */
export const BUILT_IN_ADAPTER_VERSIONS: Readonly<Record<AgentKind, string>> = Object.freeze({
  "claude-code": "1.3.0",
  "codex-cli": "1.2.2",
});

export function builtInAdapterVersion(agent: AgentKind): string {
  return BUILT_IN_ADAPTER_VERSIONS[agent];
}
