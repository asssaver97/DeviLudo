import {
  WorkflowJobError,
  type DeliverySignalWithoutId,
  type WorkflowJobExecutionContext,
  type WorkflowJobHandler,
} from "../../temporal/src/job-processor";
import type { ClaimedWorkflowJob } from "../../temporal/src/postgres-queue";
import type { TargetPlatform } from "../../../lib/domain/types";
import type {
  RunnerArtifactPreparationPort,
  RunnerArtifactPreparationReceipt,
} from "./artifact-preparation-client";

export type RunnerWorkflowMode = "CANDIDATE" | "MAIN_RELEASE_GATE" | "STEAM_CLEAN_INSTALL";

export interface RunnerWorkflowReceipt {
  readonly receiptId: string;
  readonly attemptId: string;
  readonly mode: RunnerWorkflowMode;
  readonly status: "PASSED" | "FAILED";
  readonly commitSha: string;
  readonly steamBuildId: string | null;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly evidenceBundleId: string;
  readonly repairPromptId: string | null;
}

export interface RunnerWorkflowPort {
  execute(input: {
    readonly operationKey: string;
    readonly requestDigest: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly mode: RunnerWorkflowMode;
    readonly commitSha: string;
    readonly draftPullRequest: number | null;
    readonly steamBuildId: string | null;
    readonly targetMatrix: readonly TargetPlatform[];
    readonly heartbeat: () => Promise<string>;
  }): Promise<RunnerWorkflowReceipt>;
}

export class RunnerControlWorkflowHandler implements WorkflowJobHandler {
  readonly #heartbeatIntervalMs: number;

  constructor(
    private readonly runner: RunnerWorkflowPort,
    private readonly artifacts: RunnerArtifactPreparationPort,
    options: { readonly heartbeatIntervalMs?: number } = {},
  ) {
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
    if (!Number.isInteger(this.#heartbeatIntervalMs) || this.#heartbeatIntervalMs < 10 || this.#heartbeatIntervalMs > 240_000) {
      throw new Error("Runner workflow heartbeat interval is invalid");
    }
  }

  async execute(job: ClaimedWorkflowJob, context: WorkflowJobExecutionContext): Promise<{
    readonly result: Readonly<Record<string, unknown>>;
    readonly signal: DeliverySignalWithoutId;
  }> {
    if (job.destination !== "runner-control" || job.request.kind !== "COMMAND") {
      throw new Error("Runner workflow destination is invalid");
    }
    const snapshot = job.request.payload.snapshot;
    const mode = modeFor(job.operation);
    const commitSha = mode === "CANDIDATE" ? snapshot.candidateCommitSha : snapshot.mainCommitSha;
    const draftPullRequest = mode === "CANDIDATE" ? snapshot.draftPullRequest : null;
    const steamBuildId = mode === "STEAM_CLEAN_INSTALL" ? snapshot.steamBuildId : null;
    validateSnapshot(mode, snapshot.state, snapshot.runId, commitSha, draftPullRequest, steamBuildId);
    const targetMatrix = validateMatrix(snapshot.targetMatrix);
    const preparation = mode === "STEAM_CLEAN_INSTALL" ? null : await withLeaseHeartbeats(
      () => this.artifacts.prepare({
        tenantId: job.tenantId,
        projectId: job.projectId,
        runId: snapshot.runId as string,
        lockKey: job.requestDigest,
        mode,
        commitSha: commitSha as string,
        targetMatrix,
      }),
      context.heartbeat,
      this.#heartbeatIntervalMs,
    );
    if (preparation) validatePreparationReceipt(preparation, job.tenantId, job.projectId);
    const receipt = await this.runner.execute({
      operationKey: `workflow-job:${job.id}`,
      requestDigest: job.requestDigest,
      tenantId: job.tenantId,
      projectId: job.projectId,
      workflowId: job.workflowId,
      runId: snapshot.runId as string,
      mode,
      commitSha: commitSha as string,
      draftPullRequest,
      steamBuildId,
      targetMatrix,
      heartbeat: context.heartbeat,
    });
    validateReceipt(receipt, mode, commitSha as string, steamBuildId, targetMatrix);
    const result = Object.freeze({
      receiptId: receipt.receiptId,
      attemptId: receipt.attemptId,
      mode: receipt.mode,
      status: receipt.status,
      commitSha: receipt.commitSha,
      steamBuildId: receipt.steamBuildId,
      targetMatrix: Object.freeze([...receipt.targetMatrix]),
      evidenceBundleId: receipt.evidenceBundleId,
      repairPromptId: receipt.repairPromptId,
      preparation: preparation ? Object.freeze({ ...preparation }) : null,
    });
    if (receipt.status === "FAILED") {
      if (mode === "CANDIDATE") {
        return Object.freeze({
          result,
          signal: Object.freeze({
            type: "E2E_FAILED",
            evidenceBundleId: receipt.evidenceBundleId,
            repairPromptId: receipt.repairPromptId as string,
          }),
        });
      }
      throw new WorkflowJobError(mode === "MAIN_RELEASE_GATE" ? "MAIN_SHA_E2E_FAILED" : "STEAM_INSTALL_E2E_FAILED", true);
    }
    return Object.freeze({
      result,
      signal: Object.freeze(mode === "STEAM_CLEAN_INSTALL"
        ? { type: "STEAM_INSTALL_PASSED", evidenceBundleId: receipt.evidenceBundleId }
        : { type: "E2E_PASSED", evidenceBundleId: receipt.evidenceBundleId }),
    });
  }
}

async function withLeaseHeartbeats<T>(
  operation: () => Promise<T>,
  heartbeat: () => Promise<string>,
  intervalMs: number,
): Promise<T> {
  await heartbeat();
  let heartbeatFailure: unknown = null;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = heartbeat()
      .then(() => undefined)
      .catch((error: unknown) => { heartbeatFailure = error; })
      .finally(() => { inFlight = null; });
  }, intervalMs);
  timer.unref();
  try {
    const result = await operation();
    if (inFlight) await inFlight;
    if (heartbeatFailure) throw new WorkflowJobError("RUNNER_ARTIFACT_PREPARATION_HEARTBEAT_FAILED");
    await heartbeat();
    return result;
  } finally { clearInterval(timer); }
}

function validatePreparationReceipt(
  receipt: RunnerArtifactPreparationReceipt,
  tenantId: string,
  projectId: string,
): void {
  const sourceObjectKey = `tenants/${tenantId}/projects/${projectId}/sources/${receipt.sourceArtifactDigest}.tar.zst`;
  const testPlanObjectKey = `tenants/${tenantId}/projects/${projectId}/test-plans/${receipt.testPlanDigest}.json`;
  if (!UUID_PATTERN.test(receipt.executionLockId) || !SHA256_PATTERN.test(receipt.executionLockDigest)
    || !SHA256_PATTERN.test(receipt.sourceDigest) || !SHA256_PATTERN.test(receipt.sourceArtifactDigest)
    || !SHA256_PATTERN.test(receipt.testPlanDigest)
    || receipt.sourceObjectKey !== sourceObjectKey || receipt.testPlanObjectKey !== testPlanObjectKey
    || typeof receipt.created !== "boolean") {
    throw new WorkflowJobError("RUNNER_ARTIFACT_PREPARATION_RECEIPT_INVALID", true);
  }
}

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function modeFor(operation: string): RunnerWorkflowMode {
  if (operation === "START_TARGET_MATRIX_E2E") return "CANDIDATE";
  if (operation === "START_MAIN_SHA_RELEASE_GATE") return "MAIN_RELEASE_GATE";
  if (operation === "INSTALL_FROM_CLEAN_STEAM_CLIENT") return "STEAM_CLEAN_INSTALL";
  throw new Error("Runner workflow operation is unsupported");
}

function validateSnapshot(
  mode: RunnerWorkflowMode,
  state: string,
  runId: string | null,
  commitSha: string | null,
  draftPullRequest: number | null,
  steamBuildId: string | null,
): void {
  const expectedState = mode === "CANDIDATE" ? "CROSS_PLATFORM_E2E" : mode === "MAIN_RELEASE_GATE" ? "MAIN_SHA_E2E" : "STEAM_INSTALL_E2E";
  if (state !== expectedState || !runId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(runId)
    || !commitSha || !/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("Runner workflow commit binding is invalid");
  if (mode === "CANDIDATE" && (!Number.isSafeInteger(draftPullRequest) || (draftPullRequest as number) < 1)) throw new Error("Runner workflow Draft PR binding is invalid");
  if (mode === "STEAM_CLEAN_INSTALL" && (!steamBuildId || !/^\d{1,20}$/.test(steamBuildId) || steamBuildId === "0")) throw new Error("Runner workflow Steam BuildID is invalid");
}

function validateReceipt(
  receipt: RunnerWorkflowReceipt,
  mode: RunnerWorkflowMode,
  commitSha: string,
  steamBuildId: string | null,
  matrix: readonly TargetPlatform[],
): void {
  for (const value of [receipt.receiptId, receipt.attemptId, receipt.evidenceBundleId]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error("Runner workflow receipt identity is invalid");
  }
  if (receipt.mode !== mode || receipt.commitSha !== commitSha || receipt.steamBuildId !== steamBuildId
    || JSON.stringify(receipt.targetMatrix) !== JSON.stringify(matrix)
    || !["PASSED", "FAILED"].includes(receipt.status)) throw new Error("Runner workflow receipt binding is invalid");
  if (receipt.status === "PASSED" && receipt.repairPromptId !== null) throw new Error("Passed Runner receipt contains a repair prompt");
  if (receipt.status === "FAILED" && (!receipt.repairPromptId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(receipt.repairPromptId))) {
    throw new Error("Failed Runner receipt lacks a repair prompt");
  }
}

function validateMatrix(value: readonly string[]): readonly TargetPlatform[] {
  if (!value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some((entry) => !["windows", "linux", "macos"].includes(entry))
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) throw new Error("Runner workflow target matrix is invalid");
  return Object.freeze([...value]) as readonly TargetPlatform[];
}
