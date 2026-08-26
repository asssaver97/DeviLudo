import {
  assertJobPlacement,
  isJobKind,
  jobCapabilities,
  type JobKind,
} from "@/lib/runtime/job-routing";
import {
  isServerPoolKind,
  type ServerOperatingSystem,
  type ServerPoolKind,
} from "@/lib/runtime/server-pools";

export const CORE_ROLES = ["api", "scheduler", "sandbox"] as const;
export type CoreRole = typeof CORE_ROLES[number];

export type ObjectReference = Readonly<{
  kind?: string;
  targetPlatform?: ServerOperatingSystem;
  assetKey?: string;
  metadata?: Readonly<Record<string, unknown>>;
  bucket: string;
  key: string;
  sha256: `sha256:${string}`;
  sizeBytes: number;
}>;

export type JobProtocolV4 = Readonly<{
  schemaVersion: "deviludo.job.v4";
  jobId: string;
  workflowId: string;
  workspaceId: string;
  projectId: string;
  poolKind: ServerPoolKind;
  jobKind: JobKind;
  targetOperatingSystem: ServerOperatingSystem | null;
  requiredCapabilities: readonly string[];
  exclusive: boolean;
  isolationGeneration: number;
  runtimeImage: string;
  workflowProfile: "VALIDATE" | "RELEASE";
  inputObjects: readonly ObjectReference[];
  outputContract: Readonly<{
    kinds: readonly string[];
    maxBytes: number;
  }>;
  budget: Readonly<{
    cpuMillis: number;
    memoryBytes: number;
    networkBytes: number;
  }>;
  timeoutSeconds: number;
  payload: Readonly<Record<string, unknown>>;
  lease: Readonly<{
    token: string;
    expiresAt: string;
    fencingToken: number;
  }>;
}>;

export type ClaimedJobIdentity = Readonly<{
  jobId: string;
  workspaceId: string;
  leaseToken: string;
}>;

export type JobCompletion = Readonly<{
  leaseToken: string;
  fencingToken: number;
  isolationGeneration: number;
  receipt: Readonly<Record<string, unknown>>;
  executorReceipt: Readonly<{
    schemaVersion: "deviludo.executor-receipt.v2";
    executorId: string;
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    simulated: false;
    outputObjects: readonly ObjectReference[];
    details?: Readonly<Record<string, unknown>>;
    isolationProof?: string;
    cleanupProof?: string;
    signature: string;
  }>;
  beforeReimageProof?: string;
  cleanupProof?: string;
  afterReimageProof?: string;
}>;

export function executorReceiptSigningPayload(
  receipt: Omit<JobCompletion["executorReceipt"], "signature"> | JobCompletion["executorReceipt"],
): Buffer {
  return Buffer.from(stableJson({
    schemaVersion: receipt.schemaVersion,
    executorId: receipt.executorId,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    exitCode: receipt.exitCode,
    simulated: receipt.simulated,
    outputObjects: receipt.outputObjects,
    ...(receipt.details ? { details: receipt.details } : {}),
    ...(receipt.isolationProof ? { isolationProof: receipt.isolationProof } : {}),
    ...(receipt.cleanupProof ? { cleanupProof: receipt.cleanupProof } : {}),
  }));
}

export type WorkflowSignalInput = Readonly<{
  kind: "SPEC_APPROVED" | "RELEASE_APPROVED" | "RELEASE_SKIPPED" | "STAGE_RERUN_REQUESTED" | "CANCEL_REQUESTED" | "EXTERNAL_APPROVAL";
  idempotencyKey: string;
  payload: Readonly<Record<string, unknown>>;
}>;

/**
 * Stages a user can pick as a rerun entry point, in delivery order. Rerunning
 * one supersedes it and every stage after it, so the chain has to stay ordered
 * and has to match `deviludo.delivery_stages` in the SQL baseline.
 */
export const RERUNNABLE_STAGES = [
  "AGENT_TURN",
  "BUILD",
  "E2E_PLATFORM_RUN",
  "STEAM_PUBLISH",
] as const;

export type RerunnableStage = (typeof RERUNNABLE_STAGES)[number];

export function isRerunnableStage(value: unknown): value is RerunnableStage {
  return typeof value === "string" && (RERUNNABLE_STAGES as readonly string[]).includes(value);
}

/**
 * Ordered delivery chain. Every workflow reaches a release decision after E2E;
 * Steam upload is optional and explicitly approved. The profile argument is
 * retained for stored workflow compatibility.
 */
export function deliveryStages(profile: "VALIDATE" | "RELEASE"): readonly RerunnableStage[] {
  void profile;
  return RERUNNABLE_STAGES;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{24,256}$/;

export function parseJobProtocolV4(value: unknown): JobProtocolV4 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Job payload must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== "deviludo.job.v4"
    || ![input.jobId, input.workflowId, input.workspaceId, input.projectId]
      .every(item => typeof item === "string" && UUID.test(item))
    || !isServerPoolKind(input.poolKind)
    || !isJobKind(input.jobKind)
    || !["linux", "windows", "macos", null].includes(input.targetOperatingSystem as never)
    || !Array.isArray(input.requiredCapabilities)
    || input.requiredCapabilities.some(item => typeof item !== "string" || item.length < 1 || item.length > 80)
    || typeof input.exclusive !== "boolean"
    || !Number.isSafeInteger(input.isolationGeneration)
    || Number(input.isolationGeneration) < 1
    || typeof input.runtimeImage !== "string" || !/^(?:.+@)?sha256:[0-9a-f]{64}$/i.test(input.runtimeImage)
    || !["VALIDATE", "RELEASE"].includes(String(input.workflowProfile))
    || !Array.isArray(input.inputObjects) || input.inputObjects.some(item => !isObjectReference(item))
    || !input.outputContract || typeof input.outputContract !== "object" || Array.isArray(input.outputContract)
    || !input.budget || typeof input.budget !== "object" || Array.isArray(input.budget)
    || !Number.isSafeInteger(input.timeoutSeconds) || Number(input.timeoutSeconds) < 1 || Number(input.timeoutSeconds) > 86_400
    || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)
    || !input.lease || typeof input.lease !== "object" || Array.isArray(input.lease)) {
    throw new Error("Job protocol v4 envelope is invalid");
  }
  const lease = input.lease as Record<string, unknown>;
  const outputContract = input.outputContract as Record<string, unknown>;
  const budget = input.budget as Record<string, unknown>;
  if (typeof lease.token !== "string" || !TOKEN.test(lease.token)
    || typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt))
    || !Number.isSafeInteger(lease.fencingToken) || Number(lease.fencingToken) < 1) {
    throw new Error("Job lease is invalid");
  }
  if (!Array.isArray(outputContract.kinds) || outputContract.kinds.length < 1
    || outputContract.kinds.length > 16
    || outputContract.kinds.some(kind => typeof kind !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(kind))
    || !Number.isSafeInteger(outputContract.maxBytes) || Number(outputContract.maxBytes) < 1
    || Number(outputContract.maxBytes) > 2_147_483_648) {
    throw new Error("Job output contract is invalid");
  }
  if (!Number.isSafeInteger(budget.cpuMillis) || Number(budget.cpuMillis) < 100
    || Number(budget.cpuMillis) > 86_400_000
    || !Number.isSafeInteger(budget.memoryBytes) || Number(budget.memoryBytes) < 67_108_864
    || Number(budget.memoryBytes) > 34_359_738_368
    || !Number.isSafeInteger(budget.networkBytes) || Number(budget.networkBytes) < 0
    || Number(budget.networkBytes) > 10_737_418_240) {
    throw new Error("Job resource budget is invalid");
  }
  const required = jobCapabilities(input.jobKind);
  if (required.some(capability => !(input.requiredCapabilities as unknown[]).includes(capability))) {
    throw new Error("Job capabilities do not satisfy the fixed job contract");
  }
  const e2e = String(input.poolKind).startsWith("E2E_");
  if (e2e !== input.exclusive) throw new Error("E2E jobs must be exclusive and Core jobs cannot claim a physical node");
  assertJobPlacement({
    kind: input.jobKind,
    poolKind: input.poolKind,
    targetOperatingSystem: input.targetOperatingSystem === null
      ? undefined
      : input.targetOperatingSystem as ServerOperatingSystem,
  });
  const objectPrefix = `workspaces/${String(input.workspaceId)}/projects/${String(input.projectId)}/`;
  if ((input.inputObjects as ObjectReference[]).some(item => !item.key.startsWith(objectPrefix))) {
    throw new Error("Job input object escapes the workspace/project boundary");
  }
  return input as unknown as JobProtocolV4;
}

export function parseCompletion(value: unknown): JobCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Completion must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.leaseToken !== "string" || !TOKEN.test(input.leaseToken)
    || !Number.isSafeInteger(input.fencingToken) || Number(input.fencingToken) < 1
    || !Number.isSafeInteger(input.isolationGeneration) || Number(input.isolationGeneration) < 1
    || !input.receipt || typeof input.receipt !== "object" || Array.isArray(input.receipt)
    || !input.executorReceipt || typeof input.executorReceipt !== "object" || Array.isArray(input.executorReceipt)) {
    throw new Error("Completion contract is invalid");
  }
  const executor = input.executorReceipt as Record<string, unknown>;
  if (executor.schemaVersion !== "deviludo.executor-receipt.v2"
    || typeof executor.executorId !== "string" || executor.executorId.length < 3
    || typeof executor.startedAt !== "string" || !Number.isFinite(Date.parse(executor.startedAt))
    || typeof executor.finishedAt !== "string" || !Number.isFinite(Date.parse(executor.finishedAt))
    || !Number.isSafeInteger(executor.exitCode)
    || executor.simulated !== false
    || !Array.isArray(executor.outputObjects) || executor.outputObjects.some(item => !isObjectReference(item))
    || (executor.details !== undefined && (!executor.details || typeof executor.details !== "object" || Array.isArray(executor.details)))
    || typeof executor.signature !== "string" || executor.signature.length < 32) {
    throw new Error("Executor receipt v2 is invalid or simulated");
  }
  for (const name of ["beforeReimageProof", "cleanupProof", "afterReimageProof"]) {
    const proof = input[name];
    if (proof !== undefined && (typeof proof !== "string" || proof.length < 16 || proof.length > 4096)) {
      throw new Error(`${name} is invalid`);
    }
  }
  return input as unknown as JobCompletion;
}

export function assertE2eCompletion(job: JobProtocolV4, completion: JobCompletion): void {
  if (!job.poolKind.startsWith("E2E_")) return;
  if (!completion.beforeReimageProof || !completion.cleanupProof || !completion.afterReimageProof) {
    throw new Error("E2E completion requires before-reimage, cleanup, and after-reimage proofs");
  }
  if (completion.isolationGeneration !== job.isolationGeneration) {
    throw new Error("Isolation generation does not match the leased job");
  }
}

function isObjectReference(value: unknown): value is ObjectReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.kind === undefined || typeof item.kind === "string")
    && (item.targetPlatform === undefined || ["linux", "windows", "macos"].includes(String(item.targetPlatform)))
    && (item.assetKey === undefined || isAssetKey(item.assetKey))
    && (item.metadata === undefined || Boolean(item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)))
    && typeof item.bucket === "string" && item.bucket.length > 0
    && typeof item.key === "string" && /^workspaces\/[0-9a-f-]+\/projects\/[0-9a-f-]+\//i.test(item.key)
    && typeof item.sha256 === "string" && /^sha256:[0-9a-f]{64}$/i.test(item.sha256)
    && Number.isSafeInteger(item.sizeBytes) && Number(item.sizeBytes) >= 0;
}

function isAssetKey(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value)
    && !value.endsWith("/");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
