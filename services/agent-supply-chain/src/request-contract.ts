import { sha256Canonical } from "../../runner-control/src/canonical";
import {
  parseAgentInstallationBuildReceipt,
  parseAgentInstallationRolloutReceipt,
  parseAgentVersionCandidateReceipt,
  parseAgentVersionValidationReceipt,
} from "../../control-plane/src/agent-supply-chain";
import type {
  AgentInstallationBuildRequest,
  AgentInstallationRolloutRequest,
  AgentSupplyChainOperationKind,
  AgentSupplyChainOperationResult,
  AgentSupplyChainRequest,
  AgentSupplyChainResponse,
  AgentSupplyChainTerminalFailureReceipt,
  AgentVersionDiscoveryRequest,
  AgentVersionDiscoveryResponse,
  AgentVersionValidationRequest,
} from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VALIDATION_FAILURES = new Set([
  "SIGNATURE_INVALID", "INTEGRITY_MISMATCH", "SBOM_INVALID", "MALWARE_DETECTED",
  "VULNERABILITY_POLICY_FAILED", "ADAPTER_CONTRACT_FAILED", "SANDBOX_POLICY_FAILED", "SYNTHETIC_TASK_FAILED",
]);
const BUILD_FAILURES = new Set([
  "SBOM_INVALID", "MALWARE_DETECTED", "VULNERABILITY_POLICY_FAILED", "ADAPTER_CONTRACT_FAILED",
  "SANDBOX_POLICY_FAILED", "SYNTHETIC_TASK_FAILED", "IMAGE_BUILD_FAILED",
]);
const ROLLOUT_FAILURES = new Set(["CANARY_HEALTH_FAILED", "DEPLOYMENT_HEALTH_FAILED"]);

export function parseAgentSupplyChainRequest(value: unknown): AgentSupplyChainRequest {
  const body = record(value);
  switch (body.schemaVersion) {
    case "deviludo.agent-version-discovery-request.v1":
      return discoveryRequest(body);
    case "deviludo.agent-version-validation-request.v1":
      return validationRequest(body);
    case "deviludo.agent-installation-build-request.v1":
      return buildRequest(body);
    case "deviludo.agent-installation-rollout-request.v1":
      return rolloutRequest(body);
    default:
      invalid();
  }
}

export function validateAgentSupplyChainResponse(
  value: unknown,
  request: AgentSupplyChainRequest,
): AgentSupplyChainResponse {
  if (request.schemaVersion === "deviludo.agent-version-discovery-request.v1") {
    const body = record(value);
    exactKeys(body, ["schemaVersion", "candidates"]);
    if (body.schemaVersion !== "deviludo.agent-version-discovery-receipt.v1" || !Array.isArray(body.candidates)
      || body.candidates.length < 1 || body.candidates.length > 20) invalid();
    const candidates = body.candidates.map(parseAgentVersionCandidateReceipt);
    if (candidates.some((candidate) => candidate.agent !== request.agent
      || request.requestedVersion !== null && candidate.version !== request.requestedVersion
      || !officialCandidate(candidate))) invalid();
    return Object.freeze({ schemaVersion: body.schemaVersion, candidates: Object.freeze(candidates) }) as AgentVersionDiscoveryResponse;
  }
  if (request.schemaVersion === "deviludo.agent-version-validation-request.v1") {
    return parseAgentVersionValidationReceipt(value, request.candidate);
  }
  if (request.schemaVersion === "deviludo.agent-installation-build-request.v1") {
    return parseAgentInstallationBuildReceipt(value, request);
  }
  return parseAgentInstallationRolloutReceipt(value, request);
}

export function validateAgentSupplyChainOperationResult(
  value: unknown,
  request: AgentSupplyChainRequest,
): AgentSupplyChainOperationResult {
  if (isTerminalFailureShape(value)) return parseAgentSupplyChainTerminalFailure(value, request);
  return validateAgentSupplyChainResponse(value, request);
}

export function parseAgentSupplyChainTerminalFailure(
  value: unknown,
  request: AgentSupplyChainRequest,
): AgentSupplyChainTerminalFailureReceipt {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "operationKey", "requestDigest", "operationKind", "disposition", "failureCode",
    "evidenceDigest", "failureReceiptId", "failedAt", "failureReceiptDigest",
  ]);
  const expectedKind = agentSupplyChainOperationKind(request);
  if (body.schemaVersion !== "deviludo.agent-supply-chain-terminal-failure.v1"
    || expectedKind === "DISCOVER" || body.operationKind !== expectedKind
    || body.operationKey !== request.operationKey || body.requestDigest !== request.requestDigest
    || body.disposition !== (expectedKind === "VALIDATE" ? "REJECTED" : "QUARANTINED")
    || typeof body.failureCode !== "string" || !failureCodeAllowed(expectedKind, body.failureCode)
    || typeof body.evidenceDigest !== "string" || !SHA256.test(body.evidenceDigest)
    || typeof body.failureReceiptId !== "string" || !SAFE_ID.test(body.failureReceiptId)
    || typeof body.failedAt !== "string" || !Number.isFinite(Date.parse(body.failedAt))
    || typeof body.failureReceiptDigest !== "string" || !SHA256.test(body.failureReceiptDigest)) invalid();
  const core = Object.freeze({
    schemaVersion: body.schemaVersion,
    operationKey: body.operationKey,
    requestDigest: body.requestDigest,
    operationKind: body.operationKind,
    disposition: body.disposition,
    failureCode: body.failureCode,
    evidenceDigest: body.evidenceDigest,
    failureReceiptId: body.failureReceiptId,
    failedAt: body.failedAt,
  });
  if (sha256Canonical(core) !== body.failureReceiptDigest) invalid();
  return Object.freeze({ ...core, failureReceiptDigest: body.failureReceiptDigest }) as AgentSupplyChainTerminalFailureReceipt;
}

export function isAgentSupplyChainTerminalFailure(
  value: AgentSupplyChainOperationResult,
): value is AgentSupplyChainTerminalFailureReceipt {
  return "schemaVersion" in value && value.schemaVersion === "deviludo.agent-supply-chain-terminal-failure.v1";
}

export function agentSupplyChainOperationKind(request: AgentSupplyChainRequest): AgentSupplyChainOperationKind {
  switch (request.schemaVersion) {
    case "deviludo.agent-version-discovery-request.v1": return "DISCOVER";
    case "deviludo.agent-version-validation-request.v1": return "VALIDATE";
    case "deviludo.agent-installation-build-request.v1": return "BUILD";
    case "deviludo.agent-installation-rollout-request.v1": return "ROLLOUT";
  }
}

export function agentSupplyChainPayloadDigest(request: AgentSupplyChainRequest): string {
  return sha256Canonical(request);
}

function discoveryRequest(body: Record<string, unknown>): AgentVersionDiscoveryRequest {
  exactKeys(body, ["schemaVersion", "operationKey", "requestDigest", "agent", "requestedVersion"]);
  binding(body);
  if (body.agent !== "claude-code" && body.agent !== "codex-cli") invalid();
  if (body.requestedVersion !== null && (typeof body.requestedVersion !== "string" || !exactVersion(body.requestedVersion))) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.agent-version-discovery-request.v1",
    operationKey: body.operationKey as string,
    requestDigest: body.requestDigest as string,
    agent: body.agent,
    requestedVersion: body.requestedVersion as string | null,
  });
}

function validationRequest(body: Record<string, unknown>): AgentVersionValidationRequest {
  exactKeys(body, ["schemaVersion", "operationKey", "requestDigest", "candidate"]);
  binding(body);
  const candidate = parseAgentVersionCandidateReceipt(body.candidate);
  if (!officialCandidate(candidate)) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.agent-version-validation-request.v1",
    operationKey: body.operationKey as string,
    requestDigest: body.requestDigest as string,
    candidate,
  });
}

function buildRequest(body: Record<string, unknown>): AgentInstallationBuildRequest {
  exactKeys(body, ["schemaVersion", "operationKey", "requestDigest", "installationId", "candidate", "validation",
    "workerPool", "adapterVersion", "rollbackInstallationId"]);
  binding(body);
  const candidate = parseAgentVersionCandidateReceipt(body.candidate);
  if (!officialCandidate(candidate)) invalid();
  const validation = parseAgentVersionValidationReceipt(body.validation, candidate);
  if (typeof body.installationId !== "string" || !SAFE_ID.test(body.installationId)
    || typeof body.workerPool !== "string" || !/^dev(?:elopment)?[-_a-z0-9]{0,100}$/i.test(body.workerPool)
    || typeof body.adapterVersion !== "string" || !exactVersion(body.adapterVersion)
    || body.rollbackInstallationId !== null && (typeof body.rollbackInstallationId !== "string" || !SAFE_ID.test(body.rollbackInstallationId))) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.agent-installation-build-request.v1",
    operationKey: body.operationKey as string,
    requestDigest: body.requestDigest as string,
    installationId: body.installationId,
    candidate,
    validation,
    workerPool: body.workerPool,
    adapterVersion: body.adapterVersion,
    rollbackInstallationId: body.rollbackInstallationId as string | null,
  });
}

function rolloutRequest(body: Record<string, unknown>): AgentInstallationRolloutRequest {
  exactKeys(body, ["schemaVersion", "operationKey", "requestDigest", "installationId", "imageDigest", "action", "fromPercent", "toPercent"]);
  binding(body);
  if (typeof body.installationId !== "string" || !SAFE_ID.test(body.installationId)
    || typeof body.imageDigest !== "string" || !DIGEST.test(body.imageDigest)
    || body.action !== "ADVANCE" && body.action !== "ROLLBACK"
    || !rolloutTransition(body.action, body.fromPercent, body.toPercent)) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.agent-installation-rollout-request.v1",
    operationKey: body.operationKey as string,
    requestDigest: body.requestDigest as string,
    installationId: body.installationId,
    imageDigest: body.imageDigest,
    action: body.action,
    fromPercent: body.fromPercent as 0 | 5 | 25 | 100,
    toPercent: body.toPercent as 0 | 5 | 25 | 100,
  });
}

function binding(body: Record<string, unknown>): void {
  if (typeof body.operationKey !== "string" || !SHA256.test(body.operationKey)
    || typeof body.requestDigest !== "string" || !SHA256.test(body.requestDigest)) invalid();
}

function exactVersion(value: string): boolean {
  return VERSION.test(value) && !/(?:latest|stable|default)/i.test(value);
}

function officialCandidate(candidate: ReturnType<typeof parseAgentVersionCandidateReceipt>): boolean {
  const source = candidate.agent === "claude-code"
    ? `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${candidate.version}.tgz`
    : `https://registry.npmjs.org/@openai/codex/-/codex-${candidate.version}.tgz`;
  const releaseNotes = candidate.agent === "claude-code"
    ? "https://github.com/anthropics/claude-code/releases"
    : "https://github.com/openai/codex/releases";
  return candidate.source === source && candidate.releaseNotesUrl === releaseNotes;
}

function rolloutTransition(action: unknown, from: unknown, to: unknown): boolean {
  return action === "ROLLBACK" ? to === 0 && (from === 5 || from === 25 || from === 100)
    : action === "ADVANCE" && ((from === 0 && to === 5) || (from === 5 && to === 25) || (from === 25 && to === 100));
}

function isTerminalFailureShape(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schemaVersion === "deviludo.agent-supply-chain-terminal-failure.v1";
}

function failureCodeAllowed(kind: Exclude<AgentSupplyChainOperationKind, "DISCOVER">, code: string): boolean {
  return (kind === "VALIDATE" ? VALIDATION_FAILURES : kind === "BUILD" ? BUILD_FAILURES : ROLLOUT_FAILURES).has(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
}

function invalid(): never {
  throw new Error("Agent supply-chain request or response is invalid");
}
