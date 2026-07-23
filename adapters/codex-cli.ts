import { parseCodexEvent } from "../lib/agent/events";
import {
  renderCodexProviderConfig,
} from "../lib/agent/providers";
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

const OUTPUT_SCHEMA = JSON.stringify(
  {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "changed_files", "warnings"],
    properties: {
      status: { type: "string", enum: ["completed", "blocked", "failed"] },
      summary: { type: "string" },
      changed_files: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" } },
    },
  },
  null,
  2,
);

export class CodexCliAdapter implements RuntimeAdapter {
  readonly agent = "codex-cli" as const;

  probe(target: InstallationRef | AgentProfileRevision): ProbePlan {
    const installation = "installation" in target ? target.installation : target;
    if (installation.agent !== this.agent) throw new Error("Installation is not Codex CLI");
    return Object.freeze({
      agent: this.agent,
      executable: "codex",
      argv: Object.freeze(["--version"]),
      expectedVersion: installation.cliVersion,
      imageDigest: installation.imageDigest,
    });
  }

  prepare(context: RunContext, profile: AgentProfileRevision): PreparedRuntime {
    assertAdapterInputs(this.agent, context, profile);
    const homeDirectory = runtimePath(context.runRoot, "codex-home");
    const files: readonly RuntimeFile[] = Object.freeze([
      Object.freeze({
        relativePath: "codex-home/config.toml",
        contents: renderCodexProviderConfig(context.inferenceGatewayUrl, "deviludo_gateway", {
          allowLocalLoopbackHttp: context.allowLocalLoopbackInferenceGateway === true,
        }),
        mode: 0o600 as const,
      }),
      Object.freeze({
        relativePath: "runtime/codex-output.schema.json",
        contents: OUTPUT_SCHEMA,
        mode: 0o400 as const,
      }),
    ]);
    return Object.freeze({ agent: this.agent, context, profile, homeDirectory, files });
  }

  start(runtime: PreparedRuntime, prompt: string, workspace: string): RuntimeSpec {
    if (runtime.agent !== this.agent) throw new Error("Prepared runtime is not Codex CLI");
    assertWorkspace(workspace);
    if (!prompt.trim()) throw new Error("Agent prompt must not be empty");
    const schemaPath = runtimePath(runtime.context.runRoot, "runtime/codex-output.schema.json");
    const args = Object.freeze([
      "exec",
      "--json",
      "--ephemeral",
      "--output-schema",
      schemaPath,
      "--model",
      runtime.profile.models.primaryModel,
      "--sandbox",
      "workspace-write",
      "-",
    ]);
    assertSafeArgv(args);

    return Object.freeze({
      executable: "codex",
      args,
      cwd: workspace,
      stdin: prompt,
      env: Object.freeze({
        CODEX_HOME: runtime.homeDirectory,
        DEVILUDO_AGENT_UPDATE_POLICY: "immutable-image-only",
      }),
      secretEnv: Object.freeze({
        DEVILUDO_RUN_TOKEN: runtime.context.runTokenSecretRef,
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
    return parseCodexEvent(line, timestamp);
  }
}
