import {
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

export type JobProtocolV3 = Readonly<{
  schemaVersion: "deviludo.job.v3";
  jobId: string;
  workflowId: string;
  tenantId: string;
  projectId: string;
  poolKind: ServerPoolKind;
  jobKind: JobKind;
  targetOperatingSystem: ServerOperatingSystem | null;
  requiredCapabilities: readonly string[];
  exclusive: boolean;
  isolationGeneration: number;
  payload: Readonly<Record<string, unknown>>;
  lease: Readonly<{
    token: string;
    expiresAt: string;
    fencingToken: number;
  }>;
}>;

export type ClaimedJobIdentity = Readonly<{
  jobId: string;
  tenantId: string;
  leaseToken: string;
}>;

export type JobCompletion = Readonly<{
  leaseToken: string;
  fencingToken: number;
  isolationGeneration: number;
  receipt: Readonly<Record<string, unknown>>;
  beforeReimageProof?: string;
  cleanupProof?: string;
  afterReimageProof?: string;
}>;

export type WorkflowSignalInput = Readonly<{
  kind: "SPEC_APPROVED" | "CANCEL_REQUESTED" | "EXTERNAL_APPROVAL";
  idempotencyKey: string;
  payload: Readonly<Record<string, unknown>>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{24,256}$/;

export function parseJobProtocolV3(value: unknown): JobProtocolV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Job payload must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== "deviludo.job.v3"
    || ![input.jobId, input.workflowId, input.tenantId, input.projectId]
      .every(item => typeof item === "string" && UUID.test(item))
    || !isServerPoolKind(input.poolKind)
    || !isJobKind(input.jobKind)
    || !["linux", "windows", "macos", null].includes(input.targetOperatingSystem as never)
    || !Array.isArray(input.requiredCapabilities)
    || input.requiredCapabilities.some(item => typeof item !== "string" || item.length < 1 || item.length > 80)
    || typeof input.exclusive !== "boolean"
    || !Number.isSafeInteger(input.isolationGeneration)
    || Number(input.isolationGeneration) < 1
    || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)
    || !input.lease || typeof input.lease !== "object" || Array.isArray(input.lease)) {
    throw new Error("Job protocol v3 envelope is invalid");
  }
  const lease = input.lease as Record<string, unknown>;
  if (typeof lease.token !== "string" || !TOKEN.test(lease.token)
    || typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt))
    || !Number.isSafeInteger(lease.fencingToken) || Number(lease.fencingToken) < 1) {
    throw new Error("Job lease is invalid");
  }
  const required = jobCapabilities(input.jobKind);
  if (required.some(capability => !(input.requiredCapabilities as unknown[]).includes(capability))) {
    throw new Error("Job capabilities do not satisfy the fixed job contract");
  }
  const e2e = String(input.poolKind).startsWith("E2E_");
  if (e2e !== input.exclusive) throw new Error("E2E jobs must be exclusive and Core jobs cannot claim a physical node");
  return input as unknown as JobProtocolV3;
}

export function parseCompletion(value: unknown): JobCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Completion must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.leaseToken !== "string" || !TOKEN.test(input.leaseToken)
    || !Number.isSafeInteger(input.fencingToken) || Number(input.fencingToken) < 1
    || !Number.isSafeInteger(input.isolationGeneration) || Number(input.isolationGeneration) < 1
    || !input.receipt || typeof input.receipt !== "object" || Array.isArray(input.receipt)) {
    throw new Error("Completion contract is invalid");
  }
  for (const name of ["beforeReimageProof", "cleanupProof", "afterReimageProof"]) {
    const proof = input[name];
    if (proof !== undefined && (typeof proof !== "string" || proof.length < 16 || proof.length > 4096)) {
      throw new Error(`${name} is invalid`);
    }
  }
  return input as unknown as JobCompletion;
}

export function assertE2eCompletion(job: JobProtocolV3, completion: JobCompletion): void {
  if (!job.poolKind.startsWith("E2E_")) return;
  if (!completion.beforeReimageProof || !completion.cleanupProof || !completion.afterReimageProof) {
    throw new Error("E2E completion requires before-reimage, cleanup, and after-reimage proofs");
  }
  if (completion.isolationGeneration !== job.isolationGeneration) {
    throw new Error("Isolation generation does not match the leased job");
  }
}
