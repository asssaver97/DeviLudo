import {
  assertDeliverySignal,
  GameDeliveryWorkflow,
  type DeliverySignal,
  type DeliverySnapshot,
  type DeliveryState,
} from "./game-delivery";
import type { TargetPlatform } from "../domain/types";

export const DELIVERY_PROJECTION_SCHEMA_VERSION = 1 as const;

export const DELIVERY_STATES = Object.freeze([
  "IDEATION",
  "WAITING_SPEC_APPROVAL",
  "RESOLVING_AGENT_CONFIGURATION",
  "DEVELOPMENT_QUEUED",
  "DEVELOPING",
  "WAITING_PROVIDER",
  "CROSS_PLATFORM_E2E",
  "WAITING_USER_ACCEPTANCE",
  "MERGING",
  "MAIN_SHA_E2E",
  "WAITING_MFA",
  "STEAM_PRIVATE_BETA",
  "STEAM_INSTALL_E2E",
  "EXTERNAL_APPROVAL_REQUIRED",
  "READY_TO_PUBLISH",
  "RELEASED",
  "CANCELLED",
] as const satisfies readonly DeliveryState[]);

const TARGET_PLATFORMS = new Set<TargetPlatform>(["linux", "macos", "windows"]);
const STATES = new Set<DeliveryState>(DELIVERY_STATES);
const SAFE_WORKFLOW_ID = /^delivery-[a-f0-9-]{36}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const SIGNAL_FIELDS = Object.freeze({
  SPEC_READY: ["signalId", "type", "specRevisionId"],
  SPEC_APPROVED: ["signalId", "type", "approvedSpecRevisionId", "testPlanRevisionId", "approvalReceiptId"],
  RUN_CONFIGURATION_LOCKED: ["signalId", "type", "lockedRunConfigurationId"],
  AGENT_STARTED: ["signalId", "type", "runId"],
  PROVIDER_UNAVAILABLE: ["signalId", "type", "providerRevisionId"],
  PROVIDER_RESTORED: ["signalId", "type", "providerRevisionId"],
  AGENT_COMPLETED: ["signalId", "type", "candidateCommitSha", "draftPullRequest"],
  AGENT_FAILED: ["signalId", "type", "diagnosticId"],
  E2E_PASSED: ["signalId", "type", "evidenceBundleId"],
  E2E_FAILED: ["signalId", "type", "evidenceBundleId", "repairPromptId"],
  USER_FEEDBACK: ["signalId", "type", "nextSpecRevisionId", "evidenceInvalidationId"],
  USER_ACCEPTED: ["signalId", "type"],
  MAIN_MERGED: ["signalId", "type", "mainCommitSha"],
  MFA_APPROVED: ["signalId", "type", "approvalId"],
  BETA_ACTIVATED: ["signalId", "type", "buildId"],
  STEAM_INSTALL_PASSED: ["signalId", "type", "evidenceBundleId"],
  EXTERNAL_APPROVED: ["signalId", "type", "gate", "approvalId"],
  STEAM_RELEASED: ["signalId", "type", "releaseId", "defaultBranchBuildId"],
  CANCEL: ["signalId", "type", "reason"],
} as const satisfies Record<DeliverySignal["type"], readonly string[]>);

export interface DeliveryProjectionRequest {
  readonly schemaVersion: typeof DELIVERY_PROJECTION_SCHEMA_VERSION;
  readonly projectionKey: string;
  readonly snapshot: DeliverySnapshot;
}

export interface DeliveryProjectionReceipt {
  readonly receiptId: string;
  readonly acceptedAt: string;
  readonly projectionKey: string;
  readonly workflowId: string;
  readonly sequence: number;
  readonly state: DeliveryState;
  readonly snapshotDigest: string;
  readonly replayed: boolean;
}

/** A deterministic key shared by workflow replay, activity retries and storage. */
export function deliveryProjectionKey(
  snapshot: Pick<DeliverySnapshot, "workflowId" | "state" | "history">,
): string {
  return `${snapshot.workflowId}:${snapshot.history.length}:${snapshot.state}:PROJECT_DELIVERY_SNAPSHOT`;
}

/**
 * Accept a snapshot only when replaying every exact signal produces the same
 * canonical state. This makes the projection a read model, never a second
 * workflow authority.
 */
export function parseDeliverySnapshot(value: unknown): DeliverySnapshot {
  const candidate = object(value, "Delivery snapshot");
  exactKeys(candidate, [
    "workflowId", "tenantId", "projectId", "state", "specRevisionId",
    "testPlanRevisionId", "specApprovalReceiptId", "lockedRunConfigurationId",
    "runId", "candidateCommitSha", "draftPullRequest", "mainCommitSha",
    "evidenceBundleId", "candidateEvidenceBundleId", "mainEvidenceBundleId",
    "steamInstallEvidenceBundleId", "mfaApprovalId", "steamBuildId",
    "steamReleaseId", "defaultBranchBuildId", "targetMatrix", "iteration",
    "repairAttempts", "waitingProviderRevisionId", "externalGate",
    "externalApprovals", "history",
  ], "Delivery snapshot");
  if (typeof candidate.workflowId !== "string" || !SAFE_WORKFLOW_ID.test(candidate.workflowId)
    || typeof candidate.tenantId !== "string" || !UUID.test(candidate.tenantId)
    || typeof candidate.projectId !== "string" || !UUID.test(candidate.projectId)
    || !Array.isArray(candidate.targetMatrix) || candidate.targetMatrix.length < 1
    || candidate.targetMatrix.length > TARGET_PLATFORMS.size
    || !candidate.targetMatrix.every((item) => typeof item === "string" && TARGET_PLATFORMS.has(item as TargetPlatform))
    || new Set(candidate.targetMatrix).size !== candidate.targetMatrix.length
    || !Array.isArray(candidate.history) || candidate.history.length > 100_000
    || typeof candidate.state !== "string" || !STATES.has(candidate.state as DeliveryState)) invalid("Delivery snapshot binding is invalid");

  const targetMatrix = [...candidate.targetMatrix] as TargetPlatform[];
  if (canonicalJson(targetMatrix) !== canonicalJson([...targetMatrix].sort())) {
    invalid("Delivery target matrix is not canonical");
  }
  const machine = new GameDeliveryWorkflow({
    workflowId: candidate.workflowId,
    tenantId: candidate.tenantId,
    projectId: candidate.projectId,
    targetMatrix,
  });
  for (let index = 0; index < candidate.history.length; index += 1) {
    const entry = object(candidate.history[index], "Delivery history entry");
    exactKeys(entry, ["sequence", "signal", "resultingState"], "Delivery history entry");
    if (entry.sequence !== index + 1 || typeof entry.resultingState !== "string"
      || !STATES.has(entry.resultingState as DeliveryState)) invalid("Delivery history sequence is invalid");
    const signal = exactDeliverySignal(entry.signal);
    const result = machine.signal(signal);
    if (result.state !== entry.resultingState) invalid("Delivery history resulting state is invalid");
  }
  const replayed = machine.current() as DeliverySnapshot;
  if (canonicalJson(replayed) !== canonicalJson(candidate)) {
    invalid("Delivery snapshot does not match deterministic workflow replay");
  }
  return replayed;
}

export function parseDeliveryProjectionRequest(value: unknown): DeliveryProjectionRequest {
  const body = object(value, "Delivery projection request");
  exactKeys(body, ["schemaVersion", "projectionKey", "snapshot"], "Delivery projection request");
  const snapshot = parseDeliverySnapshot(body.snapshot);
  if (body.schemaVersion !== DELIVERY_PROJECTION_SCHEMA_VERSION
    || typeof body.projectionKey !== "string"
    || body.projectionKey !== deliveryProjectionKey(snapshot)) {
    invalid("Delivery projection request binding is invalid");
  }
  return Object.freeze({
    schemaVersion: DELIVERY_PROJECTION_SCHEMA_VERSION,
    projectionKey: body.projectionKey,
    snapshot,
  });
}

export function canonicalDeliveryJson(value: unknown): string {
  return canonicalJson(value);
}

function exactDeliverySignal(value: unknown): DeliverySignal {
  const signal = object(value, "Delivery signal");
  if (typeof signal.type !== "string" || !(signal.type in SIGNAL_FIELDS)) invalid("Delivery signal type is invalid");
  exactKeys(signal, SIGNAL_FIELDS[signal.type as DeliverySignal["type"]], "Delivery signal");
  try { assertDeliverySignal(signal as unknown as DeliverySignal); }
  catch { invalid("Delivery signal binding is invalid"); }
  return Object.freeze({ ...signal }) as unknown as DeliverySignal;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length
    || actual.some((entry, index) => entry !== canonicalExpected[index])) invalid(`${name} fields are invalid`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function invalid(message: string): never {
  throw new Error(message);
}
