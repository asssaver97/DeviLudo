import { getDemoStore } from "@/lib/control-plane/demo-store";
import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";
import { acquireLocalAdminState } from "@/lib/control-plane/local-admin-state";
import {
  canCreateLocalFeedback,
  captureLocalFeedbackInvalidationAuthority,
  type LocalFeedbackInvalidationAuthority,
  type LocalDeliverySnapshot,
  type LocalTargetPlatform,
} from "@/lib/local-delivery/model";
import {
  claimLocalFeedbackCommand,
  completeLocalFeedbackCommand,
  invalidateLocalEvidence,
  listLocalFeedbackCommandResponses,
  readLocalDelivery,
  replayLocalDeliveryCommand,
  readLocalFeedbackCommand,
} from "@/lib/local-delivery/store";
import {
  authorizeLocalProjectAccess,
  authorizeProjectAccess,
  ProjectAccessError,
  projectAccessResponse,
} from "@/lib/projects/project-read-access";
import { userAcceptanceBrokerFromEnvironment, userFeedbackOperationKey } from "@/lib/user-acceptance/broker";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { createLocalSpecRuntimeHeaders } from "@/services/local-spec-runtime/src/request-auth";
import type { SpecDialogueSnapshot } from "@/services/spec-dialogue/src/contracts";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type LocalFeedbackResult = Readonly<{
  iteration: Readonly<{ id: string; text: string; revision: number; at: string }>;
  specRevisionId: string;
  invalidatedEvidence: readonly string[];
  candidatePullRequest: number | null;
  invalidationAuthority: LocalFeedbackInvalidationAuthority | null;
  state: "AWAITING_SPEC_APPROVAL";
  snapshot: SpecDialogueSnapshot;
}>;

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  if (isLoopbackTestRequest(request)) {
    try {
      await authorizeLocalProjectAccess(projectId);
      const lease = await acquireLocalAdminState();
      try {
        const legacy = getDemoStore().feedback.filter((item) => item.projectId === projectId);
        const durable = (await listLocalFeedbackCommandResponses(projectId)).map((response) => ({
          projectId,
          ...parseLocalFeedbackResult(response, projectId).iteration,
        }));
        return json({ data: [...legacy, ...durable], meta: { projectId } });
      }
      finally { lease.release(); }
    } catch (error) { return error instanceof ProjectAccessError ? projectAccessResponse(error) : problemResponse(error); }
  }
  return json({ error: { code: "METHOD_NOT_ALLOWED", message: "生产反馈历史由项目迭代视图读取" } }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    if (!PROJECT.test(projectId)) return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
    const body = await bodyObject(request);
    if (JSON.stringify(Object.keys(body)) !== JSON.stringify(["feedback"])) {
      return json({ error: { code: "INVALID_USER_FEEDBACK_REQUEST", message: "候选版本反馈格式无效" } }, { status: 400 });
    }
    const feedback = requireString(body, "feedback", 4000);
    const requestKey = idempotencyKey(request);
    if (!isLoopbackTestRequest(request)) {
      if (!UUID.test(projectId)) return invalidProject();
      const broker = userAcceptanceBrokerFromEnvironment();
      if (!broker) return productionBrokerRequired();
      const principal = await authorizeProjectAccess(request, projectId);
      const receipt = await broker.submit({
        operationKey: await userFeedbackOperationKey({
          tenantId: principal.tenantId,
          projectId,
          userId: principal.userId,
          idempotencyKey: requestKey,
        }),
        tenantId: principal.tenantId,
        projectId,
        actorId: principal.userId,
        feedback,
      });
      return json({ data: receipt, meta: { idempotentReplay: receipt.delivery.replayed } }, { status: 201 });
    }
    await authorizeLocalProjectAccess(projectId);
    const operationKey = `feedback:${projectId}:${requestKey}`;
    const requestDigest = await sha256(feedback);
    let sourceDelivery: LocalDeliverySnapshot | null = null;
    let command = await readLocalFeedbackCommand(projectId, operationKey, requestDigest);
    if (command.kind === "CONFLICT") {
      return json({ error: { code: "LOCAL_FEEDBACK_IDEMPOTENCY_CONFLICT", message: "该反馈操作键已用于不同请求。" } }, { status: 409 });
    }
    if (command.kind === "MISSING") {
      sourceDelivery = await readLocalDelivery(projectId);
      if (!canCreateLocalFeedback(sourceDelivery)) {
        return json({
          error: {
            code: "LOCAL_FEEDBACK_NOT_ALLOWED",
            message: "只有等待用户验收的候选版本或失败后的人工修复接管可以创建反馈修订。",
          },
        }, { status: 409 });
      }
      command = await claimLocalFeedbackCommand(projectId, operationKey, requestDigest);
      if (command.kind === "CONFLICT") {
        return json({ error: { code: "LOCAL_FEEDBACK_IDEMPOTENCY_CONFLICT", message: "该反馈操作键已用于不同请求。" } }, { status: 409 });
      }
    }
    const replayed = command.kind === "REPLAY";
    let result: LocalFeedbackResult;
    if (replayed) {
      result = parseLocalFeedbackResult(command.response, projectId, feedback);
    } else {
      sourceDelivery ??= await readLocalDelivery(projectId);
      const invalidationAuthority = captureLocalFeedbackInvalidationAuthority(sourceDelivery);
      const snapshot = await createLocalFeedbackDraft(request, projectId, requestKey, feedback);
      const createdAt = snapshot.messages.at(-1)?.createdAt;
      if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error("Local feedback snapshot timestamp is invalid");
      const iteration = {
        id: `ITER-${String(snapshot.revision).padStart(3, "0")}`,
        text: feedback,
        revision: snapshot.revision,
        at: createdAt,
      };
      result = Object.freeze({
        iteration,
        specRevisionId: `SPEC-${String(snapshot.revision).padStart(3, "0")}`,
        invalidatedEvidence: Object.freeze(invalidatedEvidence(invalidationAuthority)),
        candidatePullRequest: invalidationAuthority.kind === "CANDIDATE"
          ? invalidationAuthority.candidatePr
          : null,
        invalidationAuthority,
        state: "AWAITING_SPEC_APPROVAL" as const,
        snapshot,
      });
      await completeLocalFeedbackCommand(projectId, operationKey, requestDigest, JSON.stringify(result));
    }
    const deliveryCommandKey = `feedback-delivery:${projectId}:${requestKey}`;
    const delivery = result.invalidationAuthority
      ? await invalidateLocalEvidence(projectId, result.specRevisionId, deliveryCommandKey, result.invalidationAuthority)
      : await replayLegacyFeedbackInvalidation(projectId, deliveryCommandKey);
    return json(
      { data: { ...result, delivery: delivery.snapshot }, meta: { idempotentReplay: replayed || delivery.replayed } },
      { status: replayed || delivery.replayed ? 200 : 201 },
    );
  } catch (error) {
    return error instanceof ProjectAccessError ? projectAccessResponse(error) : problemResponse(error);
  }
}

function parseLocalFeedbackResult(value: string | null, projectId: string, feedback?: string): LocalFeedbackResult {
  if (!value) throw new Error("Local feedback replay is incomplete");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Local feedback replay is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Local feedback replay is invalid");
  const result = parsed as LocalFeedbackResult;
  const rawAuthority = (parsed as { invalidationAuthority?: unknown }).invalidationAuthority;
  const invalidationAuthority = rawAuthority === undefined
    ? null
    : parseInvalidationAuthority(rawAuthority, projectId);
  if ((feedback !== undefined && result.iteration?.text !== feedback) || !Number.isSafeInteger(result.iteration?.revision)
    || result.iteration.revision < 1 || !Number.isFinite(Date.parse(result.iteration.at))
    || result.state !== "AWAITING_SPEC_APPROVAL" || result.snapshot?.projectId !== projectId
    || result.snapshot.tenantId !== "tenant-local" || result.snapshot.state !== "DRAFT"
    || result.snapshot.revision !== result.iteration.revision
    || result.specRevisionId !== `SPEC-${String(result.snapshot.revision).padStart(3, "0")}`
    || !Array.isArray(result.invalidatedEvidence)
    || result.invalidatedEvidence.length > 4
    || result.invalidatedEvidence.some((id) => !validId(id))
    || new Set(result.invalidatedEvidence).size !== result.invalidatedEvidence.length
    || (result.candidatePullRequest !== null && (!Number.isSafeInteger(result.candidatePullRequest) || result.candidatePullRequest < 1))
    || (invalidationAuthority !== null
      && (JSON.stringify(result.invalidatedEvidence) !== JSON.stringify(invalidatedEvidence(invalidationAuthority))
        || result.candidatePullRequest !== (invalidationAuthority.kind === "CANDIDATE" ? invalidationAuthority.candidatePr : null)))) {
    throw new Error("Local feedback replay is invalid");
  }
  return Object.freeze({ ...structuredClone(result), invalidationAuthority });
}

function invalidatedEvidence(authority: LocalFeedbackInvalidationAuthority): string[] {
  if (authority.kind === "POST_MERGE_REPAIR") return [authority.failureEvidenceId];
  return [authority.codeReviewReceiptId, authority.evidenceId]
    .filter((value): value is string => value !== null);
}

function parseInvalidationAuthority(value: unknown, projectId: string): LocalFeedbackInvalidationAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local feedback authority is invalid");
  const authority = value as Record<string, unknown>;
  const common = authority.schemaVersion === 1 && authority.projectId === projectId
    && Number.isSafeInteger(authority.deliveryRevision) && Number(authority.deliveryRevision) >= 1
    && validId(authority.specRevisionId);
  if (!common) throw new Error("Local feedback authority is invalid");
  if (authority.kind === "CANDIDATE") {
    const expectedKeys = ["candidatePr", "candidateSha", "codeReviewReceiptId", "deliveryRevision", "evidenceBundleDigest", "evidenceId", "kind", "projectId", "runId", "schemaVersion", "specRevisionId", "targetMatrix"];
    const targetMatrix = authority.targetMatrix;
    if (JSON.stringify(Object.keys(authority).sort()) !== JSON.stringify(expectedKeys)
      || !validId(authority.runId)
      || !(authority.candidatePr === null
        ? typeof authority.codeReviewReceiptId === "string"
        : Number.isSafeInteger(authority.candidatePr) && Number(authority.candidatePr) >= 1)
      || !validId(authority.candidateSha)
      || !validNullableId(authority.codeReviewReceiptId) || !validNullableId(authority.evidenceId)
      || !validNullableDigest(authority.evidenceBundleDigest)
      || !Array.isArray(targetMatrix) || targetMatrix.length < 1 || targetMatrix.length > 3
      || targetMatrix.some((platform) => !isTargetPlatform(platform))
      || new Set(targetMatrix).size !== targetMatrix.length
      || (authority.evidenceId === null) !== (authority.evidenceBundleDigest === null)) {
      throw new Error("Local feedback authority is invalid");
    }
    return Object.freeze({ ...(authority as unknown as LocalFeedbackInvalidationAuthority), targetMatrix: Object.freeze([...(targetMatrix as LocalTargetPlatform[])]) });
  }
  const expectedKeys = ["baselineMainSha", "deliveryRevision", "failureEvidenceId", "failureReason", "kind", "previousRunId", "projectId", "repairPromptId", "schemaVersion", "specRevisionId"];
  if (authority.kind !== "POST_MERGE_REPAIR"
    || JSON.stringify(Object.keys(authority).sort()) !== JSON.stringify(expectedKeys)
    || (authority.failureReason !== "MAIN_GATE_FAILURE" && authority.failureReason !== "STEAM_INSTALL_FAILURE")
    || !validId(authority.failureEvidenceId) || !validId(authority.repairPromptId)
    || !validId(authority.previousRunId) || typeof authority.baselineMainSha !== "string"
    || !/^[a-f0-9]{40}$/.test(authority.baselineMainSha)) {
    throw new Error("Local feedback authority is invalid");
  }
  return Object.freeze(authority as unknown as LocalFeedbackInvalidationAuthority);
}

async function replayLegacyFeedbackInvalidation(projectId: string, commandKey: string) {
  const snapshot = await replayLocalDeliveryCommand(projectId, commandKey);
  if (!snapshot) throw new Error("Legacy local feedback is missing its completed invalidation receipt");
  return Object.freeze({ snapshot, replayed: true });
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function validNullableId(value: unknown): value is string | null {
  return value === null || validId(value);
}

function validNullableDigest(value: unknown): value is string | null {
  return value === null || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTargetPlatform(value: unknown): value is LocalTargetPlatform {
  return value === "linux" || value === "windows" || value === "macos";
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createLocalFeedbackDraft(
  request: Request,
  projectId: string,
  requestKey: string,
  feedback: string,
): Promise<SpecDialogueSnapshot> {
  const endpoint = localSpecRuntimeUrl(request);
  const path = `/v1/projects/${encodeURIComponent(projectId)}/feedback`;
  const command = JSON.stringify({ feedback });
  const upstream = await fetch(new URL(path, endpoint), {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": requestKey,
      ...createLocalSpecRuntimeHeaders({ method: "POST", path, body: command }),
    },
    body: command,
    signal: AbortSignal.timeout(15_000),
  });
  if (upstream.status >= 300 && upstream.status < 400) throw new Error("Local specification feedback redirected the request");
  const payload = await upstream.json() as { data?: SpecDialogueSnapshot; error?: { message?: string } };
  const snapshot = payload.data;
  if (upstream.status !== 201 || !snapshot || snapshot.tenantId !== "tenant-local"
    || snapshot.projectId !== projectId || snapshot.state !== "DRAFT"
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
    || !snapshot.conversationId || !snapshot.specRevisionId || !snapshot.testPlanRevisionId
    || !snapshot.result) {
    throw new Error(payload.error?.message ?? "Local specification feedback failed");
  }
  return snapshot;
}

function localSpecRuntimeUrl(request: Request): URL {
  if (!isLoopbackTestRequest(request)) throw new Error("Local specification runtime is unavailable");
  const url = new URL(process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_URL ?? "http://127.0.0.1:4313");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/"
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Local specification runtime URL is invalid");
  }
  return url;
}

function invalidProject(): Response {
  return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
}

function productionBrokerRequired(): Response {
  return json({
    error: {
      code: "USER_ACCEPTANCE_BROKER_REQUIRED",
      message: "生产反馈需要独立的用户验收 Broker；Web 进程不会直接生成规格或失效证据。",
    },
  }, { status: 503 });
}
