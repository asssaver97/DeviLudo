import { appendDemoAudit, withIdempotency } from "@/lib/control-plane/demo-store";
import { bodyObject, HttpProblem, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ releaseId: string }> },
) {
  try {
    const { releaseId } = await context.params;
    const body = await bodyObject(request);
    const mfaProof = request.headers.get("x-mfa-proof");
    if (!mfaProof || mfaProof.length < 16) throw new HttpProblem(403, "MFA_REQUIRED", "Accept and publish requires a fresh MFA proof");
    const mainCommitSha = requireString(body, "mainCommitSha", 40);
    if (!/^[a-f0-9]{40}$/i.test(mainCommitSha)) throw new HttpProblem(400, "INVALID_MAIN_SHA", "A full merged main SHA is required");
    const evidenceStatus = requireString(body, "evidenceStatus", 20);
    if (evidenceStatus !== "PASSED") throw new HttpProblem(409, "RELEASE_GATE_FAILED", "Release evidence for the merged main SHA has not passed");
    const result = withIdempotency(`release:${releaseId}:${idempotencyKey(request)}`, () => {
      appendDemoAudit("STEAM_PRIVATE_BETA_REQUESTED", releaseId, "ProjectOwner", { mainCommitSha, mfaVerified: true });
      return {
        releaseId,
        state: "EXTERNAL_APPROVAL_REQUIRED",
        mainCommitSha,
        steps: ["merge-confirmed", "signed-rc", "steam-beta-upload", "clean-client-install", "target-e2e"],
        externalGate: "FIRST_RELEASE",
        storesPrimaryPassword: false,
      };
    });
    return json({ data: result.value, meta: { idempotentReplay: result.replayed } }, { status: result.replayed ? 200 : 202 });
  } catch (error) {
    return problemResponse(error);
  }
}
