import { appendDemoAudit, getDemoStore, withIdempotency } from "@/lib/control-plane/demo-store";
import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  return json({ data: getDemoStore().feedback, meta: { projectId } });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const body = await bodyObject(request);
    const feedback = requireString(body, "feedback", 4000);
    const result = withIdempotency(`feedback:${projectId}:${idempotencyKey(request)}`, () => {
      const store = getDemoStore();
      store.specRevision += 1;
      store.specState = "DRAFT";
      const iteration = {
        id: `ITER-${String(store.feedback.length + 8).padStart(3, "0")}`,
        text: feedback,
        revision: store.specRevision,
        at: new Date().toISOString(),
      };
      store.feedback.push(iteration);
      store.invalidatedEvidence.push("EV-007-LNX");
      appendDemoAudit("ITERATION_CREATED", iteration.id, "ProjectOwner", {
        projectId,
        evidenceInvalidated: true,
        draftPullRequest: 18,
      });
      return {
        iteration,
        specRevisionId: `SPEC-${String(store.specRevision).padStart(3, "0")}`,
        invalidatedEvidence: ["EV-007-LNX"],
        candidatePullRequest: 18,
        state: "AWAITING_SPEC_APPROVAL",
      };
    });
    return json({ data: result.value, meta: { idempotentReplay: result.replayed } }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return problemResponse(error);
  }
}
