import { parseClaudeEvent } from "../lib/agent/events";
import { validateInternalGatewayUrl } from "../lib/agent/providers";
import type {
  AgentDiagnostics,
  AgentEvent,
  AgentProfileRevision,
  AgentRunResult,
  CancellationRequest,
  InstallationRef,
  PreparedRuntime,
  ProbePlan,
  RunContext,
  RunHandle,
  RuntimeAdapter,
  RuntimeFile,
  RuntimeSpec,
} from "../lib/agent/types";
import {
  assertAdapterInputs,
  assertSafeArgv,
  assertWorkspace,
  cancellation,
  diagnostics,
  result,
  runtimePath,
} from "./common";

const LOCKED_SETTINGS = JSON.stringify(
  {
    disableAllHooks: true,
    enableAllProjectMcpServers: false,
    enabledPlugins: {},
    permissions: {
      defaultMode: "acceptEdits",
      additionalDirectories: [],
    },
  },
  null,
  2,
);

const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} }, null, 2);

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly agent = "claude-code" as const;

  probe(target: InstallationRef | AgentProfileRevision): ProbePlan {
    const installation = "installation" in target ? target.installation : target;
    if (installation.agent !== this.agent) throw new Error("Installation is not Claude Code");
    return Object.freeze({
      agent: this.agent,
      executable: "claude",
      argv: Object.freeze(["--version"]),
      expectedVersion: installation.cliVersion,
      imageDigest: installation.imageDigest,
    });
  }

  prepare(context: RunContext, profile: AgentProfileRevision): PreparedRuntime {
    assertAdapterInputs(this.agent, context, profile);
    const homeDirectory = runtimePath(context.runRoot, "claude-home");
    const files: readonly RuntimeFile[] = Object.freeze([
      Object.freeze({
        relativePath: "claude-home/settings.json",
        contents: LOCKED_SETTINGS,
        mode: 0o400 as const,
      }),
      Object.freeze({
        relativePath: "runtime/empty-mcp.json",
        contents: EMPTY_MCP_CONFIG,
        mode: 0o400 as const,
      }),
    ]);
    return Object.freeze({ agent: this.agent, context, profile, homeDirectory, files });
  }

  start(runtime: PreparedRuntime, prompt: string, workspace: string): RuntimeSpec {
    if (runtime.agent !== this.agent) throw new Error("Prepared runtime is not Claude Code");
    assertWorkspace(workspace);
    if (!prompt.trim()) throw new Error("Agent prompt must not be empty");

    const settingsPath = runtimePath(runtime.context.runRoot, "claude-home/settings.json");
    const mcpPath = runtimePath(runtime.context.runRoot, "runtime/empty-mcp.json");
    const args = Object.freeze([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      runtime.profile.models.primaryModel,
      "--max-turns",
      String(runtime.profile.budget.maxTurns),
      "--max-budget-usd",
      formatUsd(runtime.profile.budget.maxCostUsd),
      "--no-session-persistence",
      "--setting-sources",
      "user",
      "--settings",
      settingsPath,
      "--strict-mcp-config",
      "--mcp-config",
      mcpPath,
      "--permission-mode",
      "acceptEdits",
    ]);
    assertSafeArgv(args);

    const gateway = validateInternalGatewayUrl(runtime.context.inferenceGatewayUrl);
    return Object.freeze({
      executable: "claude",
      args,
      cwd: workspace,
      stdin: `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
        parent_tool_use_id: null,
        session_id: runtime.context.runId,
      })}\n`,
      env: Object.freeze({
        CLAUDE_CONFIG_DIR: runtime.homeDirectory,
        ANTHROPIC_BASE_URL: gateway,
        ANTHROPIC_MODEL: runtime.profile.models.primaryModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: runtime.profile.models.planningModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: runtime.profile.models.primaryModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: runtime.profile.models.smallFastModel,
        CLAUDE_CODE_SUBAGENT_MODEL: runtime.profile.models.subagentModel,
        DISABLE_UPDATES: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      }),
      secretEnv: Object.freeze({
        ANTHROPIC_API_KEY: runtime.context.runTokenSecretRef,
      }),
      files: runtime.files,
      timeoutSeconds: runtime.profile.timeoutSeconds,
      redactedArgIndexes: Object.freeze([]),
    });
  }

  cancel(handle: RunHandle): CancellationRequest {
    return cancellation(handle);
  }

  collectResult(_handle: RunHandle, events: readonly AgentEvent[]): AgentRunResult {
    return result(events);
  }

  collectDiagnostics(handle: RunHandle, events: readonly AgentEvent[]): AgentDiagnostics {
    return diagnostics(handle, events);
  }

  parseEvent(line: string, timestamp?: string): AgentEvent | null {
    return parseClaudeEvent(line, timestamp);
  }
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid Claude budget");
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
