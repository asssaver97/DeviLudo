import { appendDemoAudit, getDemoStore, withIdempotency } from "@/lib/control-plane/demo-store";
import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";
import { invalidateLocalEvidence } from "@/lib/local-delivery/store";

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
    const requestKey = idempotencyKey(request);
    const result = withIdempotency(`feedback:${projectId}:${requestKey}`, () => {
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
    const delivery = await invalidateLocalEvidence(
      projectId,
      result.value.specRevisionId,
      `feedback-delivery:${projectId}:${requestKey}`,
    );
    return json(
      { data: { ...result.value, delivery: delivery.snapshot }, meta: { idempotentReplay: result.replayed || delivery.replayed } },
      { status: result.replayed || delivery.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}
