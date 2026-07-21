import { createHash } from "node:crypto";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import { validateProviderBaseUrl } from "../../../lib/security/network";
import { parseSpecModelResult, type SpecDialogueMessage } from "../../spec-dialogue/src/contracts";
import type { SpecGenerationRequest, SpecModelProviderBinding, SpecModelUsage } from "./contracts";
import { SpecModelRequestError } from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function parseSpecGenerationRequest(value: unknown): SpecGenerationRequest {
  const body = exact(value, [
    "conversationId", "current", "history", "outputSchema", "projectId",
    "schemaVersion", "tenantId", "toolsAllowed", "userMessage",
  ]);
  if (body.schemaVersion !== "deviludo.spec-generation.v1"
    || body.outputSchema !== "deviludo.spec-model-result.v1" || body.toolsAllowed !== false) invalid();
  const history = array(body.history, 0, 80).map(parseMessage);
  for (let index = 0; index < history.length; index += 1) {
    if (history[index]!.sequence !== index + 1) invalid();
    if (index > 0 && history[index]!.role === history[index - 1]!.role) invalid();
  }
  return Object.freeze({
    schemaVersion: "deviludo.spec-generation.v1",
    tenantId: uuid(body.tenantId),
    projectId: uuid(body.projectId),
    conversationId: uuid(body.conversationId),
    history: Object.freeze(history),
    current: body.current === null ? null : parseSpecModelResult(body.current),
    userMessage: text(body.userMessage, 1, 4_000),
    outputSchema: "deviludo.spec-model-result.v1",
    toolsAllowed: false,
  });
}

export function validateOperationKey(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid();
  return value;
}

export function validateProviderBinding(value: SpecModelProviderBinding): SpecModelProviderBinding {
  if (!SAFE_ID.test(value.profileRevisionId) || !SAFE_ID.test(value.providerRevisionId)
    || !SAFE_ID.test(value.credentialVersionId)
    || (value.agent !== "claude-code" && value.agent !== "codex-cli")
    || (value.protocol !== "anthropic-messages" && value.protocol !== "openai-responses")
    || !["bearer", "x-api-key", "authorization-bearer"].includes(value.authentication)
    || !SHA256.test(value.policyDigest)) invalid();
  const approvedPorts = [...value.approvedPorts];
  if (approvedPorts.length < 1 || approvedPorts.length > 16
    || new Set(approvedPorts).size !== approvedPorts.length
    || approvedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) invalid();
  validateProviderBaseUrl(value.baseUrl, { approvedPorts });
  const model = assertPinnedModelId(value.model);
  return Object.freeze({ ...value, model, approvedPorts: Object.freeze(approvedPorts) });
}

export function validateUsage(value: SpecModelUsage): SpecModelUsage {
  if (!Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0
    || !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 1
    || value.inputTokens + value.outputTokens > 10_000_000) invalid();
  return Object.freeze({ inputTokens: value.inputTokens, outputTokens: value.outputTokens });
}

export function requestDigest(request: SpecGenerationRequest): string {
  return sha256(canonical(request));
}

export function providerPolicyDigest(value: Omit<SpecModelProviderBinding, "policyDigest">): string {
  return sha256(canonical(value));
}

export function resultDigest(value: unknown): string {
  return sha256(canonical(parseSpecModelResult(value)));
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function parseMessage(value: unknown): SpecDialogueMessage {
  const body = exact(value, ["createdAt", "id", "role", "sequence", "text"]);
  if (!SAFE_ID.test(string(body.id)) || !Number.isSafeInteger(body.sequence)
    || (body.sequence as number) < 1 || (body.sequence as number) > 160
    || (body.role !== "assistant" && body.role !== "user")) invalid();
  const createdAt = string(body.createdAt);
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) invalid();
  return Object.freeze({
    id: body.id as string,
    sequence: body.sequence as number,
    role: body.role,
    text: text(body.text, 1, 4_000),
    createdAt,
  });
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return body;
}
function array(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  return value;
}
function uuid(value: unknown): string { const result = string(value); if (!UUID.test(result)) invalid(); return result; }
function string(value: unknown): string { if (typeof value !== "string" || !value) invalid(); return value; }
function text(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") invalid();
  const result = value.trim();
  if (result.length < minimum || result.length > maximum || /\u0000/.test(result)) invalid();
  return result;
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(): never { throw new SpecModelRequestError("Specification model request is invalid"); }
