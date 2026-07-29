import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { assertJobPlacement } from "@/lib/runtime/job-routing";
import {
  parseJobProtocolV3,
  type JobCompletion,
  type JobProtocolV3,
} from "@/services/core/src/contracts";
import type { E2eNodeConfig } from "./config";
import type { CoreE2eClient, SigningGrant } from "./core-client";
import type { IsolationController } from "./isolation";

export async function executeE2eJob(
  rawJob: unknown,
  config: E2eNodeConfig,
  client: CoreE2eClient,
  isolation: IsolationController,
  signal: AbortSignal,
): Promise<JobCompletion> {
  const job = parseJobProtocolV3(rawJob);
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
  let executionReceipt: Readonly<Record<string, unknown>> | null = null;
  let executionFailure: unknown;
  try {
    if (job.jobKind === "ARTIFACT_SIGN") {
      const grant = await client.issueSigningGrant(job, beforeReimageProof);
      executionReceipt = await runSigning(job, grant, signal);
    } else if (job.jobKind === "E2E_TEST") {
      executionReceipt = await runUnprivileged(job, "test", process.env.DEVILUDO_E2E_TEST_EXECUTOR ?? "", signal);
    } else {
      executionReceipt = await runUnprivileged(
        job,
        "clean-install",
        process.env.DEVILUDO_E2E_CLEAN_INSTALL_EXECUTOR ?? "",
        signal,
      );
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
  return Object.freeze({
    leaseToken: job.lease.token,
    fencingToken: job.lease.fencingToken,
    isolationGeneration: job.isolationGeneration,
    receipt: Object.freeze({
      schemaVersion: "deviludo.e2e-receipt.v1",
      jobKind: job.jobKind,
      poolKind: job.poolKind,
      operatingSystem: config.operatingSystem,
      execution: executionReceipt,
    }),
    beforeReimageProof,
    cleanupProof,
    afterReimageProof,
  });
}

async function runSigning(
  job: JobProtocolV3,
  grant: SigningGrant,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  if (Date.parse(grant.expiresAt) <= Date.now() || Date.parse(grant.expiresAt) > Date.now() + 5 * 60_000) {
    throw new Error("Signing grant lifetime is invalid");
  }
  const executable = process.env.DEVILUDO_E2E_SIGN_EXECUTOR ?? "";
  const receipt = await runExternal(executable, {
    schemaVersion: "deviludo.sign-request.v1",
    jobId: job.jobId,
    tenantId: job.tenantId,
    projectId: job.projectId,
    operatingSystem: job.targetOperatingSystem,
    payload: job.payload,
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
  job: JobProtocolV3,
  action: "test" | "clean-install",
  executable: string,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  return runExternal(executable, {
    schemaVersion: "deviludo.e2e-execution.v1",
    action,
    jobId: job.jobId,
    tenantId: job.tenantId,
    projectId: job.projectId,
    payload: job.payload,
  }, signal, action);
}

async function runExternal(
  executable: string,
  request: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  action: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!executable) {
    if (process.env.NODE_ENV === "production") throw new Error(`${action} executor is required`);
    return Object.freeze({ executor: "development-simulator", action, succeeded: true });
  }
  if (!isAbsolute(executable)) throw new Error(`${action} executor path must be absolute`);
  const child = spawn(executable, [action], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    signal,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
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
