import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentRuntimeAvailability, AgentRuntimeKind } from "@/lib/product/contracts";

const executeFile = promisify(execFile);
const NOT_INSTALLED = "NOT_INSTALLED";

type RuntimeDefinition = Readonly<{
  kind: AgentRuntimeKind;
  command: "claude" | "codex";
  overrideKey: "DEVILUDO_CLAUDE_CODE_VERSION" | "DEVILUDO_CODEX_CLI_VERSION";
}>;

const RUNTIMES: readonly RuntimeDefinition[] = Object.freeze([
  Object.freeze({ kind: "CLAUDE_CODE", command: "claude", overrideKey: "DEVILUDO_CLAUDE_CODE_VERSION" }),
  Object.freeze({ kind: "CODEX_CLI", command: "codex", overrideKey: "DEVILUDO_CODEX_CLI_VERSION" }),
]);

export type RuntimeVersionProbe = (command: "claude" | "codex") => Promise<string | null>;
export type RuntimeDetectionEnv = Readonly<Record<string, string | undefined>>;

export async function detectAgentRuntimes(
  env: RuntimeDetectionEnv = process.env,
  probe: RuntimeVersionProbe = probeRuntimeVersion,
): Promise<readonly AgentRuntimeAvailability[]> {
  const scope = env.DEVILUDO_AGENT_RUNTIME_DETECTION_SCOPE === "LOCAL_HOST"
    ? "LOCAL_HOST"
    : "CORE_RUNTIME";
  return Object.freeze(await Promise.all(RUNTIMES.map(async definition => {
    const override = env[definition.overrideKey]?.trim();
    const probed = override ? null : await probe(definition.command);
    const version = override === NOT_INSTALLED
      ? null
      : parseRuntimeVersion(override || probed || "");
    return Object.freeze({
      kind: definition.kind,
      installed: version !== null,
      version,
      scope,
    });
  })));
}

export function parseRuntimeVersion(output: string): string | null {
  const match = output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? null;
}

async function probeRuntimeVersion(command: "claude" | "codex"): Promise<string | null> {
  try {
    const result = await executeFile(command, ["--version"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 2_500,
    });
    return parseRuntimeVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return null;
  }
}
