import { createHash } from "node:crypto";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import type { ModelRoles } from "../../../lib/agent/types";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const SECRET_REF = /^(?:vault|kms|secret):\/\/[^\s?#]{1,480}$/;
const TARGETS = new Set(["linux", "macos", "windows"]);

export interface NativeMicrovmAgentRequest {
  readonly schemaVersion: "deviludo.native-agent-microvm-request.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly resolutionDigest: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly imageDigest: `sha256:${string}`;
  readonly exactAgentVersion: string;
  readonly adapterVersion: string;
  readonly agent: "claude-code" | "codex-cli";
  readonly providerRevisionId: string;
  readonly providerProtocol: "anthropic-messages" | "openai-responses";
  readonly credentialVersionId: string;
  readonly model: string;
  readonly modelRoles: ModelRoles;
  readonly authorizedModels: readonly string[];
  readonly budget: Readonly<{ maxUsd: number; maxTurns: number; timeoutSeconds: number }>;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanRevisionId: string;
  readonly testPlanDigest: string;
  readonly targetMatrix: readonly ("linux" | "macos" | "windows")[];
  readonly sourceBaselineReceiptId: string;
  readonly baseCommitSha: string;
  readonly sourceDigest: string;
  readonly inferenceGatewayUrl: string;
  readonly inferenceTokenSecretRef: string;
  readonly inferenceTokenExpiresAt: string;
  readonly inferenceAuthorizationExpiresAt: string;
  readonly prompt: string;
  readonly promptContentDigest: string;
  readonly promptDigest: string;
}

export function parseNativeMicrovmAgentRequest(value: unknown): NativeMicrovmAgentRequest {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "tenantId", "projectId", "runId", "attemptId", "resolutionDigest",
    "profileRevisionId", "installationId", "imageDigest", "exactAgentVersion", "adapterVersion", "agent",
    "providerRevisionId", "providerProtocol", "credentialVersionId", "model", "modelRoles", "authorizedModels",
    "budget", "specRevisionId", "specDigest", "testPlanRevisionId", "testPlanDigest", "targetMatrix",
    "sourceBaselineReceiptId", "baseCommitSha", "sourceDigest", "inferenceGatewayUrl",
    "inferenceTokenSecretRef", "inferenceTokenExpiresAt", "inferenceAuthorizationExpiresAt",
    "prompt", "promptContentDigest", "promptDigest"]);
  const agent = body.agent;
  const protocol = body.providerProtocol;
  if (body.schemaVersion !== "deviludo.native-agent-microvm-request.v1"
    || (agent !== "claude-code" && agent !== "codex-cli")
    || (protocol !== "anthropic-messages" && protocol !== "openai-responses")
    || (agent === "claude-code") !== (protocol === "anthropic-messages")) invalid();
  const identities = [body.tenantId, body.projectId, body.runId, body.attemptId, body.specRevisionId,
    body.testPlanRevisionId, body.sourceBaselineReceiptId];
  if (identities.some((item) => typeof item !== "string" || !UUID.test(item))) invalid();
  const safeIds = [body.profileRevisionId, body.installationId, body.adapterVersion,
    body.providerRevisionId, body.credentialVersionId];
  if (safeIds.some((item) => typeof item !== "string" || !SAFE_ID.test(item))) invalid();
  if (typeof body.imageDigest !== "string" || !IMAGE.test(body.imageDigest)
    || typeof body.exactAgentVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(body.exactAgentVersion)
    || /latest|stable|default/i.test(body.exactAgentVersion)
    || typeof body.resolutionDigest !== "string" || !SHA256.test(body.resolutionDigest)
    || typeof body.specDigest !== "string" || !SHA256.test(body.specDigest)
    || typeof body.testPlanDigest !== "string" || !SHA256.test(body.testPlanDigest)
    || typeof body.promptDigest !== "string" || !SHA256.test(body.promptDigest)
    || typeof body.promptContentDigest !== "string" || !SHA256.test(body.promptContentDigest)
    || typeof body.baseCommitSha !== "string" || !SHA1.test(body.baseCommitSha)
    || typeof body.sourceDigest !== "string" || !SHA256.test(body.sourceDigest)) invalid();
  const modelRoles = parseModelRoles(body.modelRoles);
  const authorizedModels = parseAuthorizedModels(body.authorizedModels);
  if (body.model !== modelRoles.primaryModel || !sameSet(authorizedModels, Object.values(modelRoles))) invalid();
  const budget = parseBudget(body.budget);
  const targetMatrix = parseMatrix(body.targetMatrix);
  const inferenceGatewayUrl = gateway(body.inferenceGatewayUrl);
  if (typeof body.inferenceTokenSecretRef !== "string" || !SECRET_REF.test(body.inferenceTokenSecretRef)
    || typeof body.inferenceTokenExpiresAt !== "string" || !Number.isFinite(Date.parse(body.inferenceTokenExpiresAt))
    || new Date(body.inferenceTokenExpiresAt).toISOString() !== body.inferenceTokenExpiresAt
    || typeof body.inferenceAuthorizationExpiresAt !== "string"
    || !Number.isFinite(Date.parse(body.inferenceAuthorizationExpiresAt))
    || new Date(body.inferenceAuthorizationExpiresAt).toISOString() !== body.inferenceAuthorizationExpiresAt
    || Date.parse(body.inferenceAuthorizationExpiresAt) < Date.parse(body.inferenceTokenExpiresAt)
    || typeof body.prompt !== "string" || !body.prompt.trim()
    || Buffer.byteLength(body.prompt) > 512 * 1024 || sha256(body.prompt) !== body.promptContentDigest) invalid();
  return deepFreeze({ ...body, agent, providerProtocol: protocol, imageDigest: body.imageDigest,
    modelRoles, authorizedModels, budget, targetMatrix, inferenceGatewayUrl }) as NativeMicrovmAgentRequest;
}

function parseModelRoles(value: unknown): ModelRoles {
  const body = record(value);
  exactKeys(body, ["primaryModel", "planningModel", "smallFastModel", "subagentModel"]);
  const values = [body.primaryModel, body.planningModel, body.smallFastModel, body.subagentModel];
  if (values.some((item) => typeof item !== "string" || !pinned(item))) invalid();
  return Object.freeze({ primaryModel: body.primaryModel as string, planningModel: body.planningModel as string,
    smallFastModel: body.smallFastModel as string, subagentModel: body.subagentModel as string });
}

function parseAuthorizedModels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || new Set(value).size !== value.length
    || value.some((item) => typeof item !== "string" || !pinned(item))) invalid();
  return Object.freeze([...(value as string[])]);
}

function parseBudget(value: unknown): NativeMicrovmAgentRequest["budget"] {
  const body = record(value); exactKeys(body, ["maxUsd", "maxTurns", "timeoutSeconds"]);
  if (typeof body.maxUsd !== "number" || !Number.isFinite(body.maxUsd) || body.maxUsd <= 0 || body.maxUsd > 100
    || !Number.isSafeInteger(body.maxTurns) || (body.maxTurns as number) < 1 || (body.maxTurns as number) > 200
    || !Number.isSafeInteger(body.timeoutSeconds) || (body.timeoutSeconds as number) < 60
    || (body.timeoutSeconds as number) > 24 * 60 * 60) invalid();
  return Object.freeze({ maxUsd: body.maxUsd, maxTurns: body.maxTurns as number,
    timeoutSeconds: body.timeoutSeconds as number });
}

function parseMatrix(value: unknown): NativeMicrovmAgentRequest["targetMatrix"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => typeof item !== "string" || !TARGETS.has(item))
    || JSON.stringify(value) !== JSON.stringify([...value].sort())) invalid();
  return Object.freeze([...(value as NativeMicrovmAgentRequest["targetMatrix"])]);
}

function gateway(value: unknown): string {
  if (typeof value !== "string") invalid();
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalid();
  return url.toString();
}

function pinned(value: string): boolean { try { assertPinnedModelId(value); return true; } catch { return false; } }
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...new Set(right)].sort());
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid();
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function invalid(): never { throw new Error("Native Agent microVM request is invalid"); }
