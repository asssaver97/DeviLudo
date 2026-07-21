import { appendDemoAudit, getDemoStore, withIdempotency } from "@/lib/control-plane/demo-store";
import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";
import { acquireLocalAdminState, type LocalAdminStateLease } from "@/lib/control-plane/local-admin-state";
import { startLocalDelivery } from "@/lib/local-delivery/store";
import { resolveLocalAgentProfile } from "@/lib/local-delivery/profile-resolution";
import {
  authorizeProjectAccess,
  ProjectAccessError,
  projectAccessResponse,
} from "@/lib/projects/project-read-access";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";
import {
  deterministicConversationId,
  specDialogueBrokerRuntimeFromEnvironment,
  specOperationKey,
} from "@/lib/spec-dialogue/broker";
import type { SpecApprovalReceipt } from "@/services/spec-dialogue/src/contracts";
import { createLocalSpecRuntimeHeaders } from "@/services/local-spec-runtime/src/request-auth";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  if (!isLoopbackTestRequest(request)) {
    try {
      if (!UUID.test(projectId)) return invalidProject();
      const runtime = specDialogueBrokerRuntimeFromEnvironment();
      if (!runtime) return productionBrokerRequired();
      const principal = await authorizeProjectAccess(request, projectId);
      const conversationId = await deterministicConversationId(principal.tenantId, projectId);
      const snapshot = await runtime.broker.snapshot({ tenantId: principal.tenantId, projectId, conversationId });
      if (!snapshot) return json({ error: { code: "SPEC_REVISION_NOT_FOUND", message: "项目尚未生成规格修订。" } }, { status: 404 });
      return json({
        data: {
          id: snapshot.specRevisionId,
          projectId,
          revision: snapshot.revision,
          state: snapshot.state,
          immutable: true,
          targetMatrix: snapshot.result?.spec.targetPlatforms ?? [],
          testPlan: snapshot.result ? { version: snapshot.result.testPlan.version, frozen: snapshot.state === "APPROVED" } : null,
        },
      });
    } catch (error) { return accessProblem(error); }
  }
  const lease = await acquireLocalAdminState();
  try {
    const store = getDemoStore();
    return json({
      data: {
        id: `SPEC-${String(store.specRevision).padStart(3, "0")}`,
        projectId,
        revision: store.specRevision,
        state: store.specState,
        immutable: true,
        targetMatrix: ["windows", "linux", "macos"],
        testPlan: { version: "godot-testkit-1.0.0", frozen: store.specState === "APPROVED" },
      },
    });
  } finally {
    lease.release();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  let lease: LocalAdminStateLease | null = null;
  try {
    const { projectId } = await context.params;
    if (!PROJECT.test(projectId)) return invalidProject();
    const body = await bodyObject(request);
    const action = requireString(body, "action", 32);
    const revision = requireString(body, "revision", 32);
    if (action !== "approve") {
      return json({ error: { code: "UNSUPPORTED_ACTION", message: "Only approve is supported" } }, { status: 400 });
    }
    const requestKey = idempotencyKey(request);
    const local = isLoopbackTestRequest(request);
    if (!local) {
      if (!UUID.test(projectId)) return invalidProject();
      if (!hasDialogueAuthority(body)) {
        return json({ error: { code: "SPEC_APPROVAL_AUTHORITY_REQUIRED", message: "生产规格批准必须绑定当前对话、规格修订和冻结测试计划。" } }, { status: 400 });
      }
      const runtime = specDialogueBrokerRuntimeFromEnvironment();
      if (!runtime) return productionBrokerRequired();
      const principal = await authorizeProjectAccess(request, projectId);
      const authority = await approveDialogue(request, projectId, requestKey, body, principal, runtime);
      return json({
        data: {
          specRevisionId: authority.specRevisionId,
          state: authority.state,
          authority,
          workflow: { state: "DISPATCHED_BY_SPEC_WORKFLOW_BRIDGE", localFixture: false },
        },
      }, { status: 201 });
    }
    const authority = hasDialogueAuthority(body)
      ? await approveDialogue(request, projectId, requestKey, body)
      : null;
    lease = await acquireLocalAdminState();
    const approvedRevision = authority ? `SPEC-${String(authority.revision).padStart(3, "0")}` : revision;
    const commandKey = `spec:${projectId}:${requestKey}`;
    const result = withIdempotency(commandKey, () => {
      const store = getDemoStore();
      const expected = `SPEC-${String(store.specRevision).padStart(3, "0")}`;
      const isNewProjectDraft = projectId === "new-project-draft";
      if (!authority && !isNewProjectDraft && revision !== expected) {
        throw new Error(`Optimistic revision mismatch: expected ${expected}`);
      }
      if (isNewProjectDraft || authority) {
        const parsedRevision = Number.parseInt(approvedRevision.replace(/^SPEC-/, ""), 10);
        if (!Number.isInteger(parsedRevision) || parsedRevision < 1) {
          throw new Error("Invalid specification revision");
        }
        store.specRevision = parsedRevision;
      }
      store.specState = "APPROVED";
      const runId = stableRunId(`${projectId}:${approvedRevision}:${requestKey}`);
      const lockedProfile = resolveLocalAgentProfile(
        projectId,
        authority?.testPlanRevisionId ?? "godot-testkit-1.0.0",
        store,
      );
      appendDemoAudit("SPEC_APPROVED", approvedRevision, "ProjectOwner", {
        projectId,
        runId,
        agent: lockedProfile.agent,
        profileRevisionId: lockedProfile.profileRevisionId,
        configurationSource: lockedProfile.configurationSource,
      });
      return {
        specRevisionId: approvedRevision,
        state: "APPROVED",
        authority,
        lockedProfile,
        run: {
          id: runId,
          state: "QUEUED",
          ...lockedProfile,
          targetMatrix: authority?.targetMatrix ?? ["windows", "linux", "macos"],
          locked: true,
        },
      };
    });
    if (!result.replayed) await lease.persist(commandKey);
    const delivery = await startLocalDelivery(
      projectId,
      approvedRevision,
      result.value.run.id,
      `spec-delivery:${projectId}:${requestKey}`,
      result.value.lockedProfile,
    );
    return json(
      { data: { ...result.value, delivery: delivery.snapshot }, meta: { idempotentReplay: result.replayed || delivery.replayed } },
      { status: result.replayed || delivery.replayed ? 200 : 201 },
    );
  } catch (error) {
    return accessProblem(error);
  } finally {
    lease?.release();
  }
}

function hasDialogueAuthority(body: Record<string, unknown>): boolean {
  return ["conversationId", "expectedRevision", "specRevisionId", "testPlanRevisionId"].some((field) => body[field] !== undefined);
}

async function approveDialogue(
  request: Request,
  projectId: string,
  requestKey: string,
  body: Record<string, unknown>,
  principal?: Awaited<ReturnType<typeof authorizeProjectAccess>>,
  productionRuntime?: NonNullable<ReturnType<typeof specDialogueBrokerRuntimeFromEnvironment>>,
): Promise<SpecApprovalReceipt> {
  const expected = ["action", "conversationId", "expectedRevision", "revision", "specRevisionId", "testPlanRevisionId"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected)
    || typeof body.conversationId !== "string" || typeof body.specRevisionId !== "string"
    || typeof body.testPlanRevisionId !== "string" || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 1) throw new Error("Specification approval authority is invalid");
  const local = localSpecRuntimeUrl(request);
  if (local) {
    const path = `/v1/projects/${encodeURIComponent(projectId)}/spec-approval`;
    const command = JSON.stringify({ expectedRevision: body.expectedRevision, specRevisionId: body.specRevisionId, testPlanRevisionId: body.testPlanRevisionId });
    const upstream = await fetch(new URL(path, local), {
      method: "POST", redirect: "manual",
      headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": requestKey, ...createLocalSpecRuntimeHeaders({ method: "POST", path, body: command }) },
      body: command,
      signal: AbortSignal.timeout(15_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) throw new Error("Local specification approval redirected the request");
    const payload = await upstream.json() as { data?: SpecApprovalReceipt; error?: { message?: string } };
    if (upstream.status !== 201 || !payload.data) throw new Error(payload.error?.message ?? "Local specification approval failed");
    return payload.data;
  }
  const runtime = productionRuntime ?? specDialogueBrokerRuntimeFromEnvironment();
  if (!runtime) throw new Error("Specification approval Broker is not configured");
  if (!principal) throw new Error("Specification approval project authority is missing");
  const conversationId = body.conversationId;
  const current = await runtime.broker.snapshot({
    tenantId: principal.tenantId,
    projectId,
    conversationId,
  });
  if (!current || current.state !== "DRAFT" || current.revision !== body.expectedRevision
    || current.specRevisionId !== body.specRevisionId
    || current.testPlanRevisionId !== body.testPlanRevisionId) {
    throw new Error("Specification conversation binding changed");
  }
  return runtime.broker.approve({
    tenantId: principal.tenantId, projectId, conversationId, actorId: principal.userId,
    operationKey: await specOperationKey({ tenantId: principal.tenantId, projectId, conversationId, userId: principal.userId, idempotencyKey: requestKey }),
    expectedRevision: body.expectedRevision,
    specRevisionId: body.specRevisionId,
    testPlanRevisionId: body.testPlanRevisionId,
  });
}

function localSpecRuntimeUrl(request: Request): URL | null {
  if (!isLoopbackTestRequest(request)) return null;
  const raw = process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_URL ?? "http://127.0.0.1:4313";
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/"
    || url.username || url.password || url.search || url.hash) throw new Error("Local specification runtime URL is invalid");
  return url;
}

function productionBrokerRequired(): Response {
  return json({ error: { code: "SPEC_DIALOGUE_BROKER_REQUIRED", message: "生产规格读取需要独立的规格对话 Broker。" } }, { status: 503 });
}

function invalidProject(): Response {
  return json({ error: { code: "INVALID_PROJECT", message: "项目标识无效" } }, { status: 400 });
}

function accessProblem(error: unknown): Response {
  return error instanceof ProjectAccessError ? projectAccessResponse(error) : problemResponse(error);
}

function stableRunId(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code ^ index, 0x85ebca6b);
  }
  const part = (hash: number) => (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return `RUN-${part(first)}${part(second)}`;
}
