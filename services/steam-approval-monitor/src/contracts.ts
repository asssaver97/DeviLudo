import { createHash } from "node:crypto";
import type { WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const STEAM_ID = /^[1-9][0-9]{0,19}$/;
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

export const STEAM_EXTERNAL_APPROVAL_GATES = Object.freeze([
  "VALVE_REVIEW",
  "FIRST_RELEASE",
  "DEFAULT_BRANCH_CONFIRMATION",
] as const);
export type SteamExternalApprovalGate = (typeof STEAM_EXTERNAL_APPROVAL_GATES)[number];

export const STEAM_EXTERNAL_OBSERVATION_KIND = Object.freeze({
  VALVE_REVIEW: "VALVE_REVIEW_APPROVED",
  FIRST_RELEASE: "FIRST_RELEASE_COMPLETED",
  DEFAULT_BRANCH_CONFIRMATION: "DEFAULT_BRANCH_CONFIRMED",
} as const satisfies Record<SteamExternalApprovalGate, string>);
export type SteamExternalObservationKind = (typeof STEAM_EXTERNAL_OBSERVATION_KIND)[SteamExternalApprovalGate];

export interface SteamExternalApprovalAttestation {
  readonly schemaVersion: "deviludo.steam-external-approval.v1";
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly actionId: string;
  readonly gate: SteamExternalApprovalGate;
  readonly observationKind: SteamExternalObservationKind;
  readonly steamAppId: string;
  readonly steamBuildId: string;
  readonly approvalId: string;
  /** Digest of the verifier-owned raw Steam observation; raw responses stay outside this service. */
  readonly observationDigest: string;
  readonly observedAt: string;
}

export interface SteamExternalApprovalReceipt {
  readonly schemaVersion: "deviludo.steam-external-approval-receipt.v1";
  readonly operationKey: string;
  readonly actionId: string;
  readonly workflowId: string;
  readonly gate: SteamExternalApprovalGate;
  readonly approvalId: string;
  readonly observationDigest: string;
  readonly observedAt: string;
  readonly verifierSubject: string;
  readonly delivery: WorkflowActionCompletionReceipt;
  readonly replayed: boolean;
}

export function parseSteamExternalApprovalAttestation(value: unknown): SteamExternalApprovalAttestation {
  const body = object(value);
  exactKeys(body, [
    "actionId", "approvalId", "gate", "observationDigest", "observationKind",
    "observedAt", "operationKey", "projectId", "schemaVersion", "steamAppId",
    "steamBuildId", "tenantId",
  ]);
  if (body.schemaVersion !== "deviludo.steam-external-approval.v1") invalid();
  const gate = enumValue(body.gate, STEAM_EXTERNAL_APPROVAL_GATES);
  const observationKind = text(body.observationKind, 80) as SteamExternalObservationKind;
  if (STEAM_EXTERNAL_OBSERVATION_KIND[gate] !== observationKind) invalid();
  const observedAt = text(body.observedAt, 64);
  if (!Number.isFinite(Date.parse(observedAt))) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.steam-external-approval.v1",
    operationKey: match(body.operationKey, SHA256),
    tenantId: match(body.tenantId, UUID),
    projectId: match(body.projectId, UUID),
    actionId: match(body.actionId, UUID),
    gate,
    observationKind,
    steamAppId: match(body.steamAppId, STEAM_ID),
    steamBuildId: match(body.steamBuildId, STEAM_ID),
    approvalId: match(body.approvalId, APPROVAL_ID, false),
    observationDigest: match(body.observationDigest, SHA256),
    observedAt: new Date(observedAt).toISOString(),
  });
}

export function steamExternalApprovalRequestDigest(value: SteamExternalApprovalAttestation): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function validSteamApprovalVerifierSubject(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "spiffe:" && Boolean(url.hostname) && !url.username && !url.password
      && !url.search && !url.hash && url.toString() === value;
  } catch { return false; }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid();
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid();
  return value as T;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function match(value: unknown, pattern: RegExp, lowercase = true): string {
  const result = text(value, 200);
  if (!pattern.test(result)) invalid();
  return lowercase ? result.toLowerCase() : result;
}
function invalid(): never { throw new SteamExternalApprovalRequestError(); }

export class SteamExternalApprovalRequestError extends Error {
  readonly code = "INVALID_STEAM_EXTERNAL_APPROVAL";
  constructor() { super("Steam external approval attestation is invalid"); }
}
