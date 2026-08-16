import { spawn } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  terminateChildProcess,
  waitForChildWithHardTimeout,
} from "../../../deploy/assets/e2e-process-lifecycle.mjs";
import { assertJobPlacement } from "@/lib/runtime/job-routing";
import {
  parseJobProtocolV4,
  executorReceiptSigningPayload,
  type JobCompletion,
  type JobProtocolV4,
} from "@/services/core/src/contracts";
import type { E2eNodeConfig } from "./config";
import type { CoreE2eClient } from "./core-client";
import type { IsolationController } from "./isolation";
import { e2eExecutableInvocation, e2eToolPath } from "./tool-path";

export async function executeE2eJob(
  rawJob: unknown,
  config: E2eNodeConfig,
  client: CoreE2eClient,
  isolation: IsolationController,
  signal: AbortSignal,
): Promise<JobCompletion> {
  const job = parseJobProtocolV4(rawJob);
  const startedAt = new Date().toISOString();
  if (job.poolKind !== config.poolKind || job.targetOperatingSystem !== config.operatingSystem) {
    throw new Error("E2E job does not match this node pool and operating system");
  }
  assertJobPlacement({
    kind: job.jobKind,
    poolKind: job.poolKind,
    targetOperatingSystem: job.targetOperatingSystem ?? undefined,
  });
  if (job.jobKind !== "E2E_TEST") {
    throw new Error("E2E nodes cannot execute Core jobs or install Agent software");
  }

  // Prove that the frozen Test Agent route can actually inspect pixels before
  // cloning or booting an expensive platform VM. A text-only Provider is an
  // infrastructure capability failure and must never reach product repair.
  await client.verifyPlayerPolicy(job);
  await isolation.assertAgentAbsent();
  const beforeReimageProof = await isolation.reimage(job, "before");
  let executionReceipt: Readonly<Record<string, unknown>> | null = null;
  let preparedOutputContent: Buffer | null = null;
  let preparedRegressionContent: Buffer | null = null;
  let preparedPublicReceipt: Readonly<Record<string, unknown>> | null = null;
  let executionFailure: unknown;
  try {
    const inputs = await client.authorizeObjects(job);
    executionReceipt = await runUnprivileged(job, "test", inputs, process.env.DEVILUDO_E2E_TEST_EXECUTOR ?? "", client, signal);
    validateExecutionReceipt(job, executionReceipt);
    const prepared = await readExecutorArtifact(executionReceipt);
    preparedOutputContent = prepared.content;
    preparedRegressionContent = prepared.regressionContent;
    preparedPublicReceipt = prepared.publicReceipt;
  } catch (error) {
    executionFailure = error;
  }
  let cleanupProof = "";
  let afterReimageProof = "";
  const isolationFailures: unknown[] = [];
  try {
    cleanupProof = await isolation.cleanup(job);
  } catch (error) {
    isolationFailures.push(error);
  }
  try {
    afterReimageProof = await isolation.reimage(job, "after");
  } catch (error) {
    isolationFailures.push(error);
  }
  if (executionFailure || isolationFailures.length > 0 || !executionReceipt) {
    throw new AggregateError(
      [executionFailure, ...isolationFailures].filter(value => value !== undefined),
      "E2E execution failed; cleanup and post-job reimage were attempted",
    );
  }
  const finishedAt = new Date().toISOString();
  let outputContent: Buffer;
  const publicExecutionReceipt = preparedPublicReceipt ?? executionReceipt;
  if (preparedOutputContent) {
    outputContent = preparedOutputContent;
  } else {
    outputContent = Buffer.from(JSON.stringify(executionReceipt));
  }
  const outputs = [{ kind: "E2E_REPORT", content: outputContent }];
  if (preparedRegressionContent) outputs.push({ kind: "E2E_REGRESSION", content: preparedRegressionContent });
  const outputObjects = [];
  for (const output of outputs) {
    const digest = `sha256:${createHash("sha256").update(output.content).digest("hex")}`;
    const upload = await client.uploadOutput(job, { kind: output.kind, sha256: digest, sizeBytes: output.content.length });
    const uploaded = await fetch(upload.uploadUrl, { method: "PUT", body: new Uint8Array(output.content), headers: upload.requiredHeaders, signal: AbortSignal.timeout(120_000) });
    if (!uploaded.ok) {
      const detail = (await uploaded.text()).replace(/\s+/g, " ").trim().slice(0, 1_000);
      throw new Error(`Artifact upload returned ${uploaded.status}${detail ? `: ${detail}` : ""}`);
    }
    outputObjects.push(Object.freeze({
      ...upload.object, kind: output.kind, targetPlatform: job.targetOperatingSystem ?? undefined,
      ...(output.kind === "E2E_REPORT" && executionReceipt.evidence && typeof executionReceipt.evidence === "object"
        ? { metadata: Object.freeze({ e2eEvidence: executionReceipt.evidence }) }
        : output.kind === "E2E_REGRESSION" && executionReceipt.evidence && typeof executionReceipt.evidence === "object"
          ? { metadata: Object.freeze({ e2eRegression: executionReceipt.evidence }) } : {}),
    }));
  }
  const unsigned = Object.freeze({
    schemaVersion: "deviludo.executor-receipt.v2" as const,
    executorId: config.nodeId,
    startedAt,
    finishedAt,
    exitCode: 0,
    simulated: false as const,
    outputObjects: Object.freeze(outputObjects),
  });
  const identityKey = await readFile(config.identityKeyFile, "utf8");
  const signature = sign(null, executorReceiptSigningPayload(unsigned), identityKey).toString("base64url");
  return Object.freeze({
    leaseToken: job.lease.token,
    fencingToken: job.lease.fencingToken,
    isolationGeneration: job.isolationGeneration,
    receipt: Object.freeze({
      schema: "deviludo.e2e-receipt",
      jobKind: job.jobKind,
      poolKind: job.poolKind,
      operatingSystem: config.operatingSystem,
      execution: publicExecutionReceipt,
    }),
    executorReceipt: Object.freeze({ ...unsigned, signature }),
    beforeReimageProof,
    cleanupProof,
    afterReimageProof,
  });
}

async function readExecutorArtifact(
  receipt: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ content: Buffer; regressionContent: Buffer | null; publicReceipt: Readonly<Record<string, unknown>> }>> {
  const outputPath = typeof receipt.outputPath === "string" ? receipt.outputPath : "";
  if (!isAbsolute(outputPath)) throw new Error("E2E executor did not return an absolute artifact path");
  const configuredJobRoot = process.env.DEVILUDO_E2E_JOB_ROOT ?? "";
  if (!isAbsolute(configuredJobRoot)) throw new Error("A fixed E2E job root is required for external artifacts");
  const jobRoot = resolve(configuredJobRoot);
  const resolvedOutput = resolve(outputPath);
  const relativeOutput = relative(jobRoot, resolvedOutput);
  if (relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) throw new Error("Executor output escaped the fixed E2E job root");
  const content = await readFile(resolvedOutput);
  const outputSha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (receipt.outputSha256 !== outputSha256 || receipt.outputSizeBytes !== content.length) {
    throw new Error("Executor receipt does not match its artifact bytes");
  }
  const safeReceipt = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "outputPath"));
  let regressionContent: Buffer | null = null;
  if (typeof receipt.regressionOutputPath === "string") {
    const resolvedRegression = resolve(receipt.regressionOutputPath);
    const relativeRegression = relative(jobRoot, resolvedRegression);
    if (relativeRegression.startsWith("..") || isAbsolute(relativeRegression)) throw new Error("Regression output escaped the fixed E2E job root");
    regressionContent = await readFile(resolvedRegression);
    const regressionSha256 = `sha256:${createHash("sha256").update(regressionContent).digest("hex")}`;
    if (receipt.regressionOutputSha256 !== regressionSha256 || receipt.regressionOutputSizeBytes !== regressionContent.length) {
      throw new Error("Executor regression receipt does not match its artifact bytes");
    }
  }
  delete safeReceipt.regressionOutputPath;
  return Object.freeze({ content, regressionContent, publicReceipt: Object.freeze(safeReceipt) });
}

export function validateExecutionReceipt(job: JobProtocolV4, receipt: Readonly<Record<string, unknown>>): void {
  const inputDigests = new Set(job.inputObjects.map(input => input.sha256));
  if (receipt.jobId !== job.jobId || typeof receipt.inputDigest !== "string" || !inputDigests.has(receipt.inputDigest as `sha256:${string}`)) {
    throw new Error("E2E executor receipt does not match the leased job inputs");
  }
  if (receipt.schema !== "deviludo.godot-guest-report" || Object.hasOwn(receipt, "schemaVersion")
    || receipt.action !== "test"
    || !["PASSED", "FAILED"].includes(String(receipt.outcome))
    || (receipt.outcome === "FAILED" ? receipt.failureDomain !== "PRODUCT" : receipt.failureDomain !== null)
    || typeof receipt.summary !== "string" || receipt.summary.trim().length < 1 || receipt.summary.length > 2_000
    || !receipt.guest || typeof receipt.guest !== "object" || Array.isArray(receipt.guest)) {
    throw new Error("Godot guest receipt is invalid");
  }
  const guest = receipt.guest as Record<string, unknown>;
  if (!Number.isSafeInteger(guest.exitCode)
    || (receipt.outcome === "PASSED" && guest.exitCode !== 0)
    || (receipt.outcome === "FAILED" && guest.exitCode === 0)) {
    throw new Error("Godot guest outcome does not match its exit code");
  }
  {
    const evidence = receipt.evidence as Record<string, unknown> | undefined;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
      || evidence.schema !== "deviludo.e2e-evidence" || Object.hasOwn(evidence, "protocol") || evidence.result !== receipt.outcome
      || !Number.isSafeInteger(evidence.headlessCheckCount) || Number(evidence.headlessCheckCount) < 0
      || !Number.isSafeInteger(evidence.interactiveJourneyCount) || Number(evidence.interactiveJourneyCount) < 0
      || !Number.isSafeInteger(evidence.realInputCount) || Number(evidence.realInputCount) < 0
      || !Number.isSafeInteger(evidence.deterministicInputCount) || Number(evidence.deterministicInputCount) < 0
      || !Number.isSafeInteger(evidence.keyboardMouseInputCount) || Number(evidence.keyboardMouseInputCount) < 0
      || !Number.isSafeInteger(evidence.gamepadInputCount) || Number(evidence.gamepadInputCount) < 0
      || !Number.isSafeInteger(evidence.adaptiveRolloutCount) || Number(evidence.adaptiveRolloutCount) < 0 || Number(evidence.adaptiveRolloutCount) > 3
      || !Number.isSafeInteger(evidence.adaptiveSuccessCount) || Number(evidence.adaptiveSuccessCount) < 0
      || Number(evidence.adaptiveSuccessCount) > Number(evidence.adaptiveRolloutCount)
      || !Number.isSafeInteger(evidence.adaptiveDecisionCount) || Number(evidence.adaptiveDecisionCount) < 0
      || !Number.isSafeInteger(evidence.coveredPlayerRequirementCount) || Number(evidence.coveredPlayerRequirementCount) < 0
      || !Number.isSafeInteger(evidence.playerRequirementCount) || Number(evidence.playerRequirementCount) < 0
      || Number(evidence.coveredPlayerRequirementCount) > Number(evidence.playerRequirementCount)
      || !Number.isSafeInteger(evidence.screenshotCount) || Number(evidence.screenshotCount) < 0
      || (receipt.outcome === "PASSED" && Number(evidence.screenshotCount) < 3)
      || !Number.isSafeInteger(evidence.visualBaselineCount) || Number(evidence.visualBaselineCount) < 0
      || !Number.isSafeInteger(evidence.videoCount) || Number(evidence.videoCount) < 0
      || (evidence.regressionTraceDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(String(evidence.regressionTraceDigest)))
      || ![null, "KEYBOARD_MOUSE", "GAMEPAD"].includes(evidence.regressionInputProfile as never)
      || (evidence.regressionEstimatedDurationMs !== null
        && (!Number.isSafeInteger(evidence.regressionEstimatedDurationMs)
          || Number(evidence.regressionEstimatedDurationMs) < 1 || Number(evidence.regressionEstimatedDurationMs) > 300_000))
      || ((evidence.regressionTraceDigest === null) !== (evidence.regressionInputProfile === null))
      || ((evidence.regressionTraceDigest === null) !== (evidence.regressionEstimatedDurationMs === null))
      || (receipt.outcome === "PASSED" && (Number(evidence.adaptiveRolloutCount) !== 3
        || Number(evidence.interactiveJourneyCount) < 1
        || Number(evidence.realInputCount) < 2
        || Number(evidence.adaptiveSuccessCount) < 2
        || Number(evidence.videoCount) < 1
        || Number(evidence.coveredPlayerRequirementCount) !== Number(evidence.playerRequirementCount)))
      || typeof evidence.hasVisualDiff !== "boolean"
      || ![null, "MACOS_LAUNCH_SERVICES", "WINDOWS_FINAL_EXE", "LINUX_RELEASE_EXECUTABLE"].includes(evidence.packageLaunchMode as never)
      || typeof receipt.outputPath !== "string" || !isAbsolute(receipt.outputPath)
      || typeof receipt.outputSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.outputSha256)
      || !Number.isSafeInteger(receipt.outputSizeBytes) || Number(receipt.outputSizeBytes) < 1) {
      throw new Error("Godot E2E evidence receipt is invalid");
    }
  }
  if (receipt.outcome === "PASSED" && (typeof receipt.regressionOutputPath !== "string" || !isAbsolute(receipt.regressionOutputPath)
    || typeof receipt.regressionOutputSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.regressionOutputSha256)
    || !Number.isSafeInteger(receipt.regressionOutputSizeBytes) || Number(receipt.regressionOutputSizeBytes) < 1)) {
    throw new Error("Godot E2E regression receipt is invalid");
  }
  // Optional testDetails field for structured test results
  if (receipt.testDetails !== undefined) {
    const testDetails = receipt.testDetails as Record<string, unknown>;
    if (!testDetails || typeof testDetails !== "object" || Array.isArray(testDetails)
      || typeof testDetails.suite !== "string"
      || !Array.isArray(testDetails.checks) || !testDetails.checks.every((c: unknown) => typeof c === "string")
      || !Array.isArray(testDetails.failures) || !testDetails.failures.every((f: unknown) => typeof f === "string")
      || typeof testDetails.duration_ms !== "number") {
      throw new Error("Godot guest receipt testDetails is invalid");
    }
  }
}

async function runUnprivileged(
  job: JobProtocolV4,
  action: "test",
  inputs: readonly unknown[],
  executable: string,
  client: CoreE2eClient,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  return runExternal(executable, {
    schema: "deviludo.e2e-execution",
    action,
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    payload: job.payload,
    timeoutSeconds: job.timeoutSeconds,
    inputs,
  }, job, client, signal, action);
}

async function runExternal(
  executable: string,
  request: Readonly<Record<string, unknown>>,
  job: JobProtocolV4,
  client: CoreE2eClient,
  signal: AbortSignal,
  action: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!executable) {
    throw new Error(`${action} executor is required`);
  }
  if (!isAbsolute(executable)) throw new Error(`${action} executor path must be absolute`);
  const invocation = e2eExecutableInvocation(executable, [action]);
  const killProcessGroup = process.platform !== "win32";
  const child = spawn(invocation.executable, invocation.arguments, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    signal,
    detached: killProcessGroup,
    env: {
      PATH: e2eToolPath(),
      LANG: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.DEVILUDO_E2E_GUEST_RUNNER ? { DEVILUDO_E2E_GUEST_RUNNER: process.env.DEVILUDO_E2E_GUEST_RUNNER } : {}),
      ...(process.env.DEVILUDO_E2E_JOB_ROOT ? { DEVILUDO_E2E_JOB_ROOT: process.env.DEVILUDO_E2E_JOB_ROOT } : {}),
    },
  });
  child.stdin.write(`${JSON.stringify({ type: "execute", request })}\n`);
  let result: Readonly<Record<string, unknown>> | null = null;
  let stdoutBuffer = "";
  let protocolError: Error | null = null;
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    if (protocolError) return;
    try {
      const parsed = parseE2eExecutorProtocolChunk(stdoutBuffer, chunk);
      stdoutBuffer = parsed.remainder;
      for (const message of parsed.messages) {
        if (message.type === "result" && message.value && typeof message.value === "object" && !Array.isArray(message.value)) {
          result = Object.freeze(message.value as Record<string, unknown>);
        } else if (message.type === "policy_request" && typeof message.id === "string" && message.request && typeof message.request === "object" && !Array.isArray(message.request)) {
          void client.decidePlayerPolicy(job, message.request as Record<string, unknown>)
            .then(response => child.stdin.write(`${JSON.stringify({ type: "policy_response", id: message.id, response })}\n`))
            .catch(error => child.stdin.write(`${JSON.stringify({ type: "policy_response", id: message.id, error: error instanceof Error ? error.message.slice(0, 1_000) : "Player policy failed" })}\n`));
        }
      }
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error("E2E executor protocol is invalid");
      terminateChildProcess(child, "SIGTERM", killProcessGroup);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(stderr).length < 65_536) stderr.push(chunk);
  });
  const timeoutSeconds = Number(request.timeoutSeconds);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1800 || timeoutSeconds > 5400) {
    terminateChildProcess(child, "SIGKILL", killProcessGroup);
    throw new Error(`${action} executor hard timeout is invalid`);
  }
  let childExit: Awaited<ReturnType<typeof waitForChildWithHardTimeout>>;
  try {
    childExit = await waitForChildWithHardTimeout(child, {
      timeoutMs: timeoutSeconds * 1_000 + 300_000,
      terminateGraceMs: 2_000,
      killProcessGroup,
    });
  } finally {
    child.stdin.end();
    terminateChildProcess(child, "SIGKILL", killProcessGroup);
  }
  if (childExit.timedOut) {
    throw new Error(`${action} executor exceeded its frozen hard deadline and was terminated`);
  }
  if (childExit.code !== 0 || protocolError || stdoutBuffer.trim() || !result) {
    const protocolFailure = protocolError as Error | null;
    const detail = [protocolFailure?.message, Buffer.concat(stderr).toString("utf8")]
      .filter(Boolean).join(": ").slice(0, 2_000);
    throw new Error(`${action} executor failed: ${detail}`);
  }
  return result;
}

const MAX_E2E_EXECUTOR_PROTOCOL_FRAME_BYTES = 2 * 1024 * 1024;

export function parseE2eExecutorProtocolChunk(
  previous: string,
  chunk: Buffer | string,
): Readonly<{ remainder: string; messages: readonly Readonly<Record<string, unknown>>[] }> {
  let buffer = previous + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  const messages: Readonly<Record<string, unknown>>[] = [];
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (Buffer.byteLength(line) > MAX_E2E_EXECUTOR_PROTOCOL_FRAME_BYTES) {
      throw new Error("E2E executor protocol frame exceeds its limit");
    }
    if (line.trim()) {
      const message = JSON.parse(line) as unknown;
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new Error("E2E executor protocol frame must be an object");
      }
      messages.push(Object.freeze(message as Record<string, unknown>));
    }
    newline = buffer.indexOf("\n");
  }
  if (Buffer.byteLength(buffer) > MAX_E2E_EXECUTOR_PROTOCOL_FRAME_BYTES) {
    throw new Error("E2E executor protocol frame exceeds its limit");
  }
  return Object.freeze({ remainder: buffer, messages: Object.freeze(messages) });
}
