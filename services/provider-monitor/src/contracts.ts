import { createHash } from "node:crypto";
import type { WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";
import type { ProviderProbeConfiguration } from "../../control-plane/src/provider-probe";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ProviderRecoveryRequest {
  readonly schemaVersion: "deviludo.provider-recovery-check.v1";
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly actionId: string;
}

export interface ProviderRecoveryReceipt {
  readonly schemaVersion: "deviludo.provider-recovery-receipt.v1";
  readonly operationKey: string;
  readonly actionId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly providerRevisionId: string;
  readonly probeDigest: string;
  readonly probedAt: string;
  readonly schedulerSubject: string;
  readonly delivery: WorkflowActionCompletionReceipt;
  readonly replayed: boolean;
}

export interface ProviderRecoveryAuthority {
  readonly workflowId: string;
  readonly runId: string;
  readonly provider: ProviderProbeConfiguration;
}

export function parseProviderRecoveryRequest(value: unknown): ProviderRecoveryRequest {
  const body = object(value);
  const keys = ["actionId", "operationKey", "projectId", "schemaVersion", "tenantId"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(keys)) invalid();
  if (body.schemaVersion !== "deviludo.provider-recovery-check.v1") invalid();
  const request = Object.freeze({
    schemaVersion: "deviludo.provider-recovery-check.v1",
    operationKey: match(body.operationKey, SHA256),
    tenantId: match(body.tenantId, UUID),
    projectId: match(body.projectId, UUID),
    actionId: match(body.actionId, UUID),
  });
  if (request.operationKey !== providerRecoveryOperationKey(request)) invalid();
  return request;
}

/** A single waiting workflow action has one recovery ledger across all callers. */
export function providerRecoveryOperationKey(
  value: Pick<ProviderRecoveryRequest, "tenantId" | "projectId" | "actionId">,
): string {
  const tenantId = match(value.tenantId, UUID);
  const projectId = match(value.projectId, UUID);
  const actionId = match(value.actionId, UUID);
  return sha256Canonical(Object.freeze({
    schemaVersion: "deviludo.provider-recovery-operation.v1",
    tenantId,
    projectId,
    actionId,
  }));
}

export function providerRecoveryRequest(
  value: Pick<ProviderRecoveryRequest, "tenantId" | "projectId" | "actionId">,
): ProviderRecoveryRequest {
  const tenantId = match(value.tenantId, UUID);
  const projectId = match(value.projectId, UUID);
  const actionId = match(value.actionId, UUID);
  return Object.freeze({
    schemaVersion: "deviludo.provider-recovery-check.v1",
    operationKey: providerRecoveryOperationKey({ tenantId, projectId, actionId }),
    tenantId,
    projectId,
    actionId,
  });
}

export function providerRecoveryRequestDigest(value: ProviderRecoveryRequest): string {
  return sha256Canonical(value);
}

export function providerProbeDigest(value: Readonly<Record<string, "PASS" | "FAIL">>): string {
  return sha256Canonical(value);
}

export function validSchedulerSubject(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "spiffe:" && Boolean(url.hostname) && url.pathname !== "/"
      && !url.username && !url.password && !url.search && !url.hash && url.toString() === value;
  } catch { return false; }
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function match(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value.toLowerCase();
}
function invalid(): never { throw new ProviderRecoveryRequestError(); }

export class ProviderRecoveryRequestError extends Error {
  readonly code = "INVALID_PROVIDER_RECOVERY_CHECK";
  constructor() { super("Provider recovery check is invalid"); }
}
