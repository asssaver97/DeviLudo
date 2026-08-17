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

export type CodexAuthenticationMethod = "CHATGPT" | "API_KEY" | "SIGNED_OUT";

const RUNTIMES: readonly RuntimeDefinition[] = Object.freeze([
  Object.freeze({ kind: "CLAUDE_CODE", command: "claude", overrideKey: "DEVILUDO_CLAUDE_CODE_VERSION" }),
  Object.freeze({ kind: "CODEX_CLI", command: "codex", overrideKey: "DEVILUDO_CODEX_CLI_VERSION" }),
]);

export type RuntimeVersionProbe = (command: "claude" | "codex") => Promise<string | null>;
export type CodexAuthenticationProbe = () => Promise<string | null>;
export type RuntimeDetectionEnv = Readonly<Record<string, string | undefined>>;

export async function detectAgentRuntimes(
  env: RuntimeDetectionEnv = process.env,
  probe: RuntimeVersionProbe = probeRuntimeVersion,
  authenticationProbe: CodexAuthenticationProbe = probeCodexAuthentication,
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
    const authentication = definition.kind === "CODEX_CLI" && version !== null
      ? codexAuthenticationMethod(env.DEVILUDO_CODEX_LOGIN_METHOD ?? await authenticationProbe())
      : null;
    return Object.freeze({
      kind: definition.kind,
      installed: version !== null,
      version,
      scope,
      authentication,
    });
  })));
}

export function codexAuthenticationMethod(output: string | null | undefined): CodexAuthenticationMethod {
  const value = output?.trim() ?? "";
  if (/^(CHATGPT|Logged in using ChatGPT)$/i.test(value)) return "CHATGPT";
  if (/^(API_KEY|Logged in using (?:an )?API key)$/i.test(value)) return "API_KEY";
  return "SIGNED_OUT";
}

export function parseRuntimeVersion(output: string): string | null {
  const match = output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? null;
}

/**
 * These CLIs are Node programs that can take several seconds to answer on a cold
 * start, and a timeout is indistinguishable from an absent command: both surface as
 * `installed: false`, so too short a limit reports an installed runtime as missing.
 * A command that does not exist still fails immediately, so the longer allowance
 * only costs time for one that is present and slow.
 */
async function probeRuntimeVersion(command: "claude" | "codex"): Promise<string | null> {
  try {
    const result = await executeFile(command, ["--version"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 30_000,
    });
    return parseRuntimeVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return null;
  }
}

async function probeCodexAuthentication(): Promise<string | null> {
  try {
    const result = await executeFile("codex", ["login", "status"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 30_000,
    });
    return `${result.stdout}\n${result.stderr}`;
  } catch {
    return null;
  }
}
