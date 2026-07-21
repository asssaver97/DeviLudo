import type { TargetPlatform } from "../../../lib/domain/types";
import {
  parseRunnerToolchainRevision,
  type RunnerToolchainRevisionPayload,
} from "../../../lib/domain/runner-toolchain";
import { sha256Canonical } from "../../runner-control/src/canonical";

export { parseRunnerToolchainRevision } from "../../../lib/domain/runner-toolchain";
export type { RunnerToolchainRevisionPayload } from "../../../lib/domain/runner-toolchain";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TARGETS = new Set<TargetPlatform>(["windows", "linux", "macos"]);

export interface SourceExecutionPreparationRequest {
  readonly schemaVersion: "deviludo.source-execution-preparation.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly lockKey: string;
  readonly mode: "CANDIDATE" | "MAIN_RELEASE_GATE";
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly runnerToolchainRevisionId: string;
  readonly runnerToolchainDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly toolchain: Readonly<RunnerToolchainRevisionPayload>;
}

/** Minimal workflow-owned message. Every executable binding is re-resolved server-side. */
export interface SourceExecutionPreparationTrigger {
  readonly schemaVersion: "deviludo.source-execution-preparation-trigger.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly lockKey: string;
  readonly mode: "CANDIDATE" | "MAIN_RELEASE_GATE";
  readonly commitSha: string;
  readonly targetMatrix: readonly TargetPlatform[];
}

export function parseSourceExecutionPreparationTrigger(value: unknown): SourceExecutionPreparationTrigger {
  const body = record(value, "trigger");
  exactKeys(body, [
    "schemaVersion", "tenantId", "projectId", "runId", "lockKey", "mode", "commitSha", "targetMatrix",
  ], "trigger");
  if (body.schemaVersion !== "deviludo.source-execution-preparation-trigger.v1") invalid("trigger schema version");
  return deepFreeze({
    schemaVersion: "deviludo.source-execution-preparation-trigger.v1",
    tenantId: required(body.tenantId, UUID, "tenant"),
    projectId: required(body.projectId, UUID, "project"),
    runId: required(body.runId, UUID, "run"),
    lockKey: required(body.lockKey, SHA256, "lock key"),
    mode: mode(body.mode),
    commitSha: required(body.commitSha, SHA1, "commit"),
    targetMatrix: matrix(body.targetMatrix),
  });
}

export function parseSourceExecutionPreparationRequest(value: unknown): SourceExecutionPreparationRequest {
  const body = record(value, "request");
  exactKeys(body, [
    "schemaVersion", "tenantId", "projectId", "runId", "lockKey", "mode", "commitSha",
    "sourceDigest", "specRevisionId", "specDigest", "testPlanDigest", "runnerToolchainRevisionId",
    "runnerToolchainDigest", "targetMatrix", "toolchain",
  ], "request");
  if (body.schemaVersion !== "deviludo.source-execution-preparation.v1") invalid("schema version");
  const targetMatrix = matrix(body.targetMatrix);
  const toolchain = parseRunnerToolchainRevision(body.toolchain, targetMatrix);
  const runnerToolchainDigest = required(body.runnerToolchainDigest, SHA256, "Runner toolchain digest");
  if (sha256Canonical(toolchain) !== runnerToolchainDigest) invalid("Runner toolchain payload digest");
  return deepFreeze({
    schemaVersion: "deviludo.source-execution-preparation.v1",
    tenantId: required(body.tenantId, UUID, "tenant"),
    projectId: required(body.projectId, UUID, "project"),
    runId: required(body.runId, UUID, "run"),
    lockKey: required(body.lockKey, SHA256, "lock key"),
    mode: mode(body.mode),
    commitSha: required(body.commitSha, SHA1, "commit"),
    sourceDigest: required(body.sourceDigest, SHA256, "source digest"),
    specRevisionId: required(body.specRevisionId, UUID, "spec revision"),
    specDigest: required(body.specDigest, SHA256, "spec digest"),
    testPlanDigest: required(body.testPlanDigest, SHA256, "test plan digest"),
    runnerToolchainRevisionId: required(body.runnerToolchainRevisionId, UUID, "Runner toolchain revision"),
    runnerToolchainDigest,
    targetMatrix,
    toolchain,
  });
}

function matrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => typeof item !== "string" || !TARGETS.has(item as TargetPlatform))) invalid("target matrix");
  const parsed = [...value].sort() as TargetPlatform[];
  if (JSON.stringify(parsed) !== JSON.stringify(value)) invalid("target matrix ordering");
  return Object.freeze(parsed);
}

function mode(value: unknown): "CANDIDATE" | "MAIN_RELEASE_GATE" {
  if (value !== "CANDIDATE" && value !== "MAIN_RELEASE_GATE") invalid("mode");
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid(`${label} fields`);
}

function required(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(label);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Artifact preparation ${label} is invalid`);
}
