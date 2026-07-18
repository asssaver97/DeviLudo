import { createHash } from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WORKFLOW_ID = /^delivery-[a-f0-9-]{36}$/;

export interface SourceBaselineRequest {
  readonly schemaVersion: "deviludo.source-baseline.v1";
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly specApprovalReceiptId: string;
}

export interface SourceBaselineReceipt {
  readonly schemaVersion: "deviludo.source-baseline-receipt.v1";
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly specApprovalReceiptId: string;
  readonly sourceBaselineReceiptId: string;
  readonly repositoryBindingId: string;
  readonly defaultBranch: string;
  readonly commitSha: string;
  readonly sourceDigest: string;
  readonly observedAt: string;
  readonly replayed: boolean;
}

export function parseSourceBaselineRequest(value: unknown): SourceBaselineRequest {
  const body = exact(value, [
    "operationKey", "projectId", "schemaVersion", "specApprovalReceiptId",
    "specRevisionId", "tenantId", "testPlanRevisionId", "workflowId",
  ]);
  if (body.schemaVersion !== "deviludo.source-baseline.v1") invalid();
  const projectId = match(body.projectId, UUID);
  const workflowId = match(body.workflowId, WORKFLOW_ID);
  if (workflowId !== `delivery-${projectId}`) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.source-baseline.v1",
    operationKey: match(body.operationKey, SHA256),
    tenantId: match(body.tenantId, UUID),
    projectId,
    workflowId,
    specRevisionId: match(body.specRevisionId, UUID),
    testPlanRevisionId: match(body.testPlanRevisionId, UUID),
    specApprovalReceiptId: match(body.specApprovalReceiptId, SHA256),
  });
}

export function parseSourceBaselineReceipt(value: unknown): SourceBaselineReceipt {
  const body = exact(value, [
    "commitSha", "defaultBranch", "observedAt", "operationKey", "projectId",
    "replayed", "repositoryBindingId", "schemaVersion", "sourceBaselineReceiptId",
    "sourceDigest", "specApprovalReceiptId", "specRevisionId", "tenantId",
    "testPlanRevisionId", "workflowId",
  ]);
  if (body.schemaVersion !== "deviludo.source-baseline-receipt.v1"
    || typeof body.replayed !== "boolean") invalid();
  const observedAt = text(body.observedAt, 64);
  if (!Number.isFinite(Date.parse(observedAt))) invalid();
  const projectId = match(body.projectId, UUID);
  const workflowId = match(body.workflowId, WORKFLOW_ID);
  if (workflowId !== `delivery-${projectId}`) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.source-baseline-receipt.v1",
    operationKey: match(body.operationKey, SHA256),
    tenantId: match(body.tenantId, UUID),
    projectId,
    workflowId,
    specRevisionId: match(body.specRevisionId, UUID),
    testPlanRevisionId: match(body.testPlanRevisionId, UUID),
    specApprovalReceiptId: match(body.specApprovalReceiptId, SHA256),
    sourceBaselineReceiptId: match(body.sourceBaselineReceiptId, UUID),
    repositoryBindingId: match(body.repositoryBindingId, UUID),
    defaultBranch: branch(body.defaultBranch),
    commitSha: match(body.commitSha, SHA1),
    sourceDigest: match(body.sourceDigest, SHA256),
    observedAt: new Date(observedAt).toISOString(),
    replayed: body.replayed,
  });
}

export function sourceBaselineRequestDigest(request: SourceBaselineRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

export function sourceBaselineOperationKey(actionId: string): string {
  if (!UUID.test(actionId)) invalid();
  return createHash("sha256").update(`source-baseline\0${actionId.toLowerCase()}`).digest("hex");
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return body;
}
function match(value: unknown, pattern: RegExp): string {
  const result = text(value, 512);
  if (!pattern.test(result)) invalid();
  return result.toLowerCase();
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function branch(value: unknown): string {
  const result = text(value, 255);
  if (result === "@" || result.startsWith("/") || result.startsWith(".")
    || result.endsWith("/") || result.endsWith(".") || result.endsWith(".lock")
    || result.includes("..") || result.includes("//") || result.includes("@{")
    || [" ", "~", "^", ":", "?", "*", "[", "\\"].some((character) => result.includes(character))) invalid();
  return result;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}
function invalid(): never { throw new Error("Source baseline binding is invalid"); }
