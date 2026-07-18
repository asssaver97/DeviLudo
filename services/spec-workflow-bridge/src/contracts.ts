import { createHash } from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const GODOT_VERSION = /^4\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9]+)*$/;
const PLATFORM_ORDER = ["linux", "macos", "windows"] as const;

export type SpecWorkflowPlatform = (typeof PLATFORM_ORDER)[number];

export interface SpecWorkflowApprovalRequest {
  readonly schemaVersion: "deviludo.spec-workflow-approval.v1";
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly draftSpecRevisionId: string;
  readonly draftTestPlanRevisionId: string;
  readonly approvedSpecRevisionId: string;
  readonly approvedSpecDigest: string;
  readonly approvedTestPlanRevisionId: string;
  readonly approvedTestPlanDigest: string;
  readonly targetMatrix: readonly SpecWorkflowPlatform[];
  readonly godotVersion: string;
  readonly approvedAt: string;
}

export interface SpecWorkflowEvent {
  readonly eventKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly conversationId: string;
  readonly eventType: "SPEC_READY" | "SPEC_APPROVED";
  readonly requestDigest: string;
  readonly payload: SpecWorkflowApprovalRequest;
  readonly claimToken: string;
}

export interface SpecWorkflowEnqueueReceipt {
  readonly workflowId: string;
  /** Present only when the project workflow still needs its initial SPEC_READY. */
  readonly readyEventKey: string | null;
  readonly approvalEventKey: string;
  readonly state: "PENDING_DELIVERY" | "DELIVERED";
  readonly replayed: boolean;
}

export function parseSpecWorkflowApprovalRequest(value: unknown): SpecWorkflowApprovalRequest {
  const body = object(value);
  exactKeys(body, [
    "approvedAt", "approvedSpecDigest", "approvedSpecRevisionId",
    "approvedTestPlanDigest", "approvedTestPlanRevisionId", "conversationId",
    "draftSpecRevisionId", "draftTestPlanRevisionId", "godotVersion",
    "operationKey", "projectId", "schemaVersion", "targetMatrix", "tenantId",
  ]);
  if (body.schemaVersion !== "deviludo.spec-workflow-approval.v1") invalid();
  const approvedAt = text(body.approvedAt, 64);
  if (!Number.isFinite(Date.parse(approvedAt))) invalid();
  const targetMatrix = parseSpecWorkflowTargetMatrix(body.targetMatrix);
  const godotVersion = text(body.godotVersion, 80);
  if (!GODOT_VERSION.test(godotVersion)) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.spec-workflow-approval.v1",
    operationKey: match(body.operationKey, SHA256),
    tenantId: match(body.tenantId, UUID),
    projectId: match(body.projectId, UUID),
    conversationId: match(body.conversationId, UUID),
    draftSpecRevisionId: match(body.draftSpecRevisionId, UUID),
    draftTestPlanRevisionId: match(body.draftTestPlanRevisionId, UUID),
    approvedSpecRevisionId: match(body.approvedSpecRevisionId, UUID),
    approvedSpecDigest: match(body.approvedSpecDigest, SHA256),
    approvedTestPlanRevisionId: match(body.approvedTestPlanRevisionId, UUID),
    approvedTestPlanDigest: match(body.approvedTestPlanDigest, SHA256),
    targetMatrix,
    godotVersion,
    approvedAt: new Date(approvedAt).toISOString(),
  });
}

export function specWorkflowId(projectId: string): string {
  if (!UUID.test(projectId)) invalid();
  return `delivery-${projectId.toLowerCase()}`;
}

export function specWorkflowRequestDigest(request: SpecWorkflowApprovalRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

export function specWorkflowEventKey(operationKey: string, type: SpecWorkflowEvent["eventType"]): string {
  if (!SHA256.test(operationKey)) invalid();
  return createHash("sha256").update(`${operationKey}\0${type}`).digest("hex");
}

export function parseStoredSpecWorkflowRequest(value: unknown): SpecWorkflowApprovalRequest {
  if (typeof value === "string") {
    try { return parseSpecWorkflowApprovalRequest(JSON.parse(value) as unknown); }
    catch { invalid(); }
  }
  return parseSpecWorkflowApprovalRequest(value);
}

export function parseSpecWorkflowTargetMatrix(value: unknown): readonly SpecWorkflowPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || value.some((item) => !PLATFORM_ORDER.includes(item as SpecWorkflowPlatform))
    || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...value]) as readonly SpecWorkflowPlatform[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid();
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

function match(value: unknown, pattern: RegExp): string {
  const result = text(value, 200);
  if (!pattern.test(result)) invalid();
  return result.toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function invalid(): never { throw new Error("Specification workflow approval binding is invalid"); }
