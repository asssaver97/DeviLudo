import { appendDemoAudit, getDemoStore, withIdempotency } from "@/lib/control-plane/demo-store";
import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";

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
    const result = withIdempotency(`spec:${projectId}:${idempotencyKey(request)}`, () => {
      const store = getDemoStore();
      const expected = `SPEC-${String(store.specRevision).padStart(3, "0")}`;
      const isNewProjectDraft = projectId === "new-project-draft";
      if (!isNewProjectDraft && revision !== expected) {
        throw new Error(`Optimistic revision mismatch: expected ${expected}`);
      }
      if (isNewProjectDraft) {
        const parsedRevision = Number.parseInt(revision.replace(/^SPEC-/, ""), 10);
        if (!Number.isInteger(parsedRevision) || parsedRevision < 1) {
          throw new Error("Invalid specification revision");
        }
        store.specRevision = parsedRevision;
      }
      store.specState = "APPROVED";
      const runId = `RUN-${1043 + store.feedback.length}`;
      appendDemoAudit("SPEC_APPROVED", revision, "ProjectOwner", { projectId, runId, agent: "claude-code" });
      return {
        specRevisionId: revision,
        state: "APPROVED",
        run: {
          id: runId,
          state: "QUEUED",
          profileRevisionId: "profile-claude-platform-r5",
          installationId: "claude-installation-214",
          exactAgentVersion: "2.1.14",
          adapterVersion: "1.0.0",
          model: "claude-sonnet-4-6-20250514",
          credentialVersionId: "cred-claude-platform-v4",
          targetMatrix: ["windows", "linux", "macos"],
          locked: true,
        },
      };
    });
    return json({ data: result.value, meta: { idempotentReplay: result.replayed } }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return problemResponse(error);
  }
}
