import { spawn } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { assertJobPlacement } from "@/lib/runtime/job-routing";
import {
  parseJobProtocolV4,
  executorReceiptSigningPayload,
  type JobCompletion,
  type JobProtocolV4,
} from "@/services/core/src/contracts";
import type { E2eNodeConfig } from "./config";
import type { CoreE2eClient, SigningGrant } from "./core-client";
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
  if (!["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"].includes(job.jobKind)) {
    throw new Error("E2E nodes cannot execute Core jobs or install Agent software");
  }

  await isolation.assertAgentAbsent();
  const beforeReimageProof = await isolation.reimage(job, "before");
  const inputs = await client.authorizeObjects(job);
  let executionReceipt: Readonly<Record<string, unknown>> | null = null;
  let preparedOutputContent: Buffer | null = null;
  let preparedPublicReceipt: Readonly<Record<string, unknown>> | null = null;
  let executionFailure: unknown;
  try {
    if (job.jobKind === "ARTIFACT_SIGN") {
      const grant = await client.issueSigningGrant(job, beforeReimageProof);
      executionReceipt = await runSigning(job, grant, inputs, signal);
    } else if (job.jobKind === "E2E_TEST") {
      executionReceipt = await runUnprivileged(job, "test", inputs, process.env.DEVILUDO_E2E_TEST_EXECUTOR ?? "", signal);
    } else {
      executionReceipt = await runUnprivileged(
        job,
        "clean-install",
        inputs,
        process.env.DEVILUDO_E2E_CLEAN_INSTALL_EXECUTOR ?? "",
        signal,
      );
    }
    validateExecutionReceipt(job, executionReceipt);
    if (job.jobKind === "ARTIFACT_SIGN" || job.jobKind === "E2E_TEST") {
      const prepared = await readExecutorArtifact(executionReceipt, job.jobKind);
      preparedOutputContent = prepared.content;
      preparedPublicReceipt = prepared.publicReceipt;
    }
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
  const artifactKind = job.jobKind === "E2E_TEST" ? "E2E_REPORT"
    : job.jobKind === "ARTIFACT_SIGN" ? "SIGNED_BUILD" : "CLEAN_INSTALL_REPORT";
  let outputContent: Buffer;
  const publicExecutionReceipt = preparedPublicReceipt ?? executionReceipt;
  if (preparedOutputContent) {
    outputContent = preparedOutputContent;
  } else {
    outputContent = Buffer.from(JSON.stringify(executionReceipt));
  }
  const outputDigest = `sha256:${createHash("sha256").update(outputContent).digest("hex")}`;
  const upload = await client.uploadOutput(job, { kind: artifactKind, sha256: outputDigest, sizeBytes: outputContent.length });
  const uploaded = await fetch(upload.uploadUrl, { method: "PUT", body: new Uint8Array(outputContent), headers: upload.requiredHeaders, signal: AbortSignal.timeout(120_000) });
  if (!uploaded.ok) {
    const detail = (await uploaded.text()).replace(/\s+/g, " ").trim().slice(0, 1_000);
    throw new Error(`Artifact upload returned ${uploaded.status}${detail ? `: ${detail}` : ""}`);
  }
  const outputObjects = Object.freeze([Object.freeze({
    ...upload.object,
    kind: artifactKind,
    targetPlatform: job.targetOperatingSystem ?? undefined,
    ...(job.jobKind === "E2E_TEST" && executionReceipt.evidence && typeof executionReceipt.evidence === "object"
      ? { metadata: Object.freeze({ e2eEvidence: executionReceipt.evidence }) }
      : {}),
  })]);
  const unsigned = Object.freeze({
    schemaVersion: "deviludo.executor-receipt.v2" as const,
    executorId: config.nodeId,
    startedAt,
    finishedAt,
    exitCode: 0,
    simulated: false as const,
    outputObjects,
  });
  const identityKey = await readFile(config.identityKeyFile, "utf8");
  const signature = sign(null, executorReceiptSigningPayload(unsigned), identityKey).toString("base64url");
  return Object.freeze({
    leaseToken: job.lease.token,
    fencingToken: job.lease.fencingToken,
    isolationGeneration: job.isolationGeneration,
    receipt: Object.freeze({
      schemaVersion: "deviludo.e2e-receipt.v1",
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
  kind: "ARTIFACT_SIGN" | "E2E_TEST",
): Promise<Readonly<{ content: Buffer; publicReceipt: Readonly<Record<string, unknown>> }>> {
  const outputPath = typeof receipt.outputPath === "string" ? receipt.outputPath : "";
  if (!isAbsolute(outputPath)) throw new Error(`${kind === "E2E_TEST" ? "E2E" : "Signing"} executor did not return an absolute artifact path`);
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
  return Object.freeze({ content, publicReceipt: Object.freeze(safeReceipt) });
}

export function validateExecutionReceipt(job: JobProtocolV4, receipt: Readonly<Record<string, unknown>>): void {
  const inputDigests = new Set(job.inputObjects.map(input => input.sha256));
  if (receipt.jobId !== job.jobId || typeof receipt.inputDigest !== "string" || !inputDigests.has(receipt.inputDigest as `sha256:${string}`)) {
    throw new Error("E2E executor receipt does not match the leased job inputs");
  }
  if (job.jobKind === "ARTIFACT_SIGN") {
    if (receipt.schemaVersion !== "deviludo.platform-sign-receipt.v1"
      || receipt.targetPlatform !== job.targetOperatingSystem
      || typeof receipt.outputSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.outputSha256)
      || !Number.isSafeInteger(receipt.outputSizeBytes) || Number(receipt.outputSizeBytes) < 1) {
      throw new Error("Platform signing receipt is invalid");
    }
    return;
  }
  const expectedAction = job.jobKind === "E2E_TEST" ? "test" : "clean-install";
  if (receipt.schemaVersion !== "deviludo.godot-guest-report.v2"
    || receipt.action !== expectedAction
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
  if (job.jobKind === "E2E_TEST") {
    const evidence = receipt.evidence as Record<string, unknown> | undefined;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
      || evidence.protocol !== "deviludo.e2e-evidence.v1" || evidence.result !== receipt.outcome
      || !Number.isSafeInteger(evidence.checkCount) || Number(evidence.checkCount) < 0
      || !Number.isSafeInteger(evidence.screenshotCount) || Number(evidence.screenshotCount) < 0
      || (receipt.outcome === "PASSED" && Number(evidence.screenshotCount) < 3)
      || typeof evidence.hasVisualDiff !== "boolean"
      || typeof receipt.outputPath !== "string" || !isAbsolute(receipt.outputPath)
      || typeof receipt.outputSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.outputSha256)
      || !Number.isSafeInteger(receipt.outputSizeBytes) || Number(receipt.outputSizeBytes) < 1) {
      throw new Error("Godot E2E evidence receipt is invalid");
    }
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

async function runSigning(
  job: JobProtocolV4,
  grant: SigningGrant,
  inputs: readonly unknown[],
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  if (Date.parse(grant.expiresAt) <= Date.now() || Date.parse(grant.expiresAt) > Date.now() + 5 * 60_000) {
    throw new Error("Signing grant lifetime is invalid");
  }
  const executable = process.env.DEVILUDO_E2E_SIGN_EXECUTOR ?? "";
  const receipt = await runExternal(executable, {
    schemaVersion: "deviludo.sign-request.v1",
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    operatingSystem: job.targetOperatingSystem,
    payload: job.payload,
    inputs,
    grant: {
      grantId: grant.grantId,
      wrappedToken: grant.wrappedToken,
      expiresAt: grant.expiresAt,
    },
  }, signal, "sign");
  return Object.freeze({
    ...receipt,
    grantId: grant.grantId,
    operationId: grant.operationId,
    grantExpiresAt: grant.expiresAt,
  });
}

async function runUnprivileged(
  job: JobProtocolV4,
  action: "test" | "clean-install",
  inputs: readonly unknown[],
  executable: string,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  return runExternal(executable, {
    schemaVersion: "deviludo.e2e-execution.v1",
    action,
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    payload: job.payload,
    inputs,
  }, signal, action);
}

async function runExternal(
  executable: string,
  request: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  action: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!executable) {
    throw new Error(`${action} executor is required`);
  }
  if (!isAbsolute(executable)) throw new Error(`${action} executor path must be absolute`);
  const invocation = e2eExecutableInvocation(executable, [action]);
  const child = spawn(invocation.executable, invocation.arguments, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    signal,
    env: {
      PATH: e2eToolPath(),
      LANG: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.DEVILUDO_E2E_GUEST_RUNNER ? { DEVILUDO_E2E_GUEST_RUNNER: process.env.DEVILUDO_E2E_GUEST_RUNNER } : {}),
      ...(process.env.DEVILUDO_E2E_JOB_ROOT ? { DEVILUDO_E2E_JOB_ROOT: process.env.DEVILUDO_E2E_JOB_ROOT } : {}),
      ...(process.env.DEVILUDO_E2E_SIGNING_BROKER_URL ? { DEVILUDO_E2E_SIGNING_BROKER_URL: process.env.DEVILUDO_E2E_SIGNING_BROKER_URL } : {}),
    },
  });
  child.stdin.end(JSON.stringify(request));
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 1_048_576) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(stderr).length < 65_536) stderr.push(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0 || bytes > 1_048_576) {
    throw new Error(`${action} executor failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 2_000)}`);
  }
  const value = JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${action} receipt is invalid`);
  return Object.freeze(value as Record<string, unknown>);
}
