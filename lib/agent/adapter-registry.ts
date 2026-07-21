import type { AgentKind } from "./types";
import { AGENT_REGISTRY } from "./registry";

/** Exact Adapter versions compiled into this control-plane release. */
export const BUILT_IN_ADAPTER_VERSIONS: Readonly<Record<AgentKind, string>> = Object.freeze({
  "claude-code": AGENT_REGISTRY["claude-code"].adapterVersion,
  "codex-cli": AGENT_REGISTRY["codex-cli"].adapterVersion,
});

export function builtInAdapterVersion(agent: AgentKind): string {
  return BUILT_IN_ADAPTER_VERSIONS[agent];
}

export function isBuiltInAdapterVersion(agent: AgentKind, version: string): boolean {
  return builtInAdapterVersion(agent) === version;
}
