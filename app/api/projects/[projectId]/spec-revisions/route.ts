import { appendDemoAudit, getDemoStore, withIdempotency } from "@/lib/control-plane/demo-store";
import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";
import { startLocalDelivery } from "@/lib/local-delivery/store";
import {
  specDialogueBrokerRuntimeFromEnvironment,
  specOperationKey,
  verifyTrustedSpecSession,
} from "@/lib/spec-dialogue/broker";
import type { SpecApprovalReceipt } from "@/services/spec-dialogue/src/contracts";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
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
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const body = await bodyObject(request);
    const action = requireString(body, "action", 32);
    const revision = requireString(body, "revision", 32);
    if (action !== "approve") {
      return json({ error: { code: "UNSUPPORTED_ACTION", message: "Only approve is supported" } }, { status: 400 });
    }
    const requestKey = idempotencyKey(request);
    const authority = hasDialogueAuthority(body)
      ? await approveDialogue(request, projectId, requestKey, body)
      : null;
    const approvedRevision = authority ? `SPEC-${String(authority.revision).padStart(3, "0")}` : revision;
    const result = withIdempotency(`spec:${projectId}:${requestKey}`, () => {
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
      appendDemoAudit("SPEC_APPROVED", approvedRevision, "ProjectOwner", { projectId, runId, agent: "claude-code" });
      return {
        specRevisionId: approvedRevision,
        state: "APPROVED",
        authority,
        run: {
          id: runId,
          state: "QUEUED",
          profileRevisionId: "profile-claude-platform-r5",
          installationId: "claude-installation-214",
          exactAgentVersion: "2.1.14",
          adapterVersion: "1.0.0",
          model: "claude-sonnet-4-6-20250514",
          credentialVersionId: "cred-claude-platform-v4",
          targetMatrix: authority?.targetMatrix ?? ["windows", "linux", "macos"],
          locked: true,
        },
      };
    });
    const delivery = await startLocalDelivery(
      projectId,
      approvedRevision,
      result.value.run.id,
      `spec-delivery:${projectId}:${requestKey}`,
    );
    return json(
      { data: { ...result.value, delivery: delivery.snapshot }, meta: { idempotentReplay: result.replayed || delivery.replayed } },
      { status: result.replayed || delivery.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
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
): Promise<SpecApprovalReceipt> {
  const expected = ["action", "conversationId", "expectedRevision", "revision", "specRevisionId", "testPlanRevisionId"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected)
    || typeof body.conversationId !== "string" || typeof body.specRevisionId !== "string"
    || typeof body.testPlanRevisionId !== "string" || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 1) throw new Error("Specification approval authority is invalid");
  const local = localSpecRuntimeUrl(request);
  if (local) {
    const upstream = await fetch(new URL(`/v1/projects/${encodeURIComponent(projectId)}/spec-approval`, local), {
      method: "POST", redirect: "manual",
      headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": requestKey, "x-deviludo-local-spec-runtime": "v1" },
      body: JSON.stringify({ expectedRevision: body.expectedRevision, specRevisionId: body.specRevisionId, testPlanRevisionId: body.testPlanRevisionId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) throw new Error("Local specification approval redirected the request");
    const payload = await upstream.json() as { data?: SpecApprovalReceipt; error?: { message?: string } };
    if (upstream.status !== 201 || !payload.data) throw new Error(payload.error?.message ?? "Local specification approval failed");
    return payload.data;
  }
  const runtime = specDialogueBrokerRuntimeFromEnvironment();
  if (!runtime) throw new Error("Specification approval Broker is not configured");
  const principal = await verifyTrustedSpecSession(request, runtime.sessionHmacKey);
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
  const requestHost = new URL(request.url).hostname;
  if (requestHost !== "127.0.0.1" && requestHost !== "localhost") return null;
  const raw = process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_URL ?? "http://127.0.0.1:4313";
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/"
    || url.username || url.password || url.search || url.hash) throw new Error("Local specification runtime URL is invalid");
  return url;
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
