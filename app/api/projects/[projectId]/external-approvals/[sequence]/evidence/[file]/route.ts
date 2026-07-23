import { json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";
import { authorizeLocalProjectAccess } from "@/lib/projects/project-read-access";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; sequence: string; file: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "本地外部批准证据只在显式启用的 loopback 测试站可用");
    const { projectId, sequence, file } = await context.params;
    await authorizeLocalProjectAccess(projectId);
    const sequenceNumber = Number(sequence);
    if (file !== "manifest.json" || !Number.isInteger(sequenceNumber) || sequenceNumber < 1 || sequenceNumber > 3) {
      return json({ error: { code: "NOT_FOUND", message: "本地外部批准证据不存在" } }, { status: 404 });
    }
    const delivery = await readLocalDelivery(projectId);
    const evidence = delivery.externalApprovalEvidence[sequenceNumber - 1];
    if (!delivery.runId || !evidence?.valid || evidence.sequence !== sequenceNumber) {
      return json({ error: { code: "EVIDENCE_NOT_READY", message: "本地外部批准证据尚未生成或已失效" } }, { status: 404 });
    }
    const path = `/v1/external-approvals/${encodeURIComponent(projectId)}/${encodeURIComponent(delivery.runId)}/${sequenceNumber}/evidence/manifest.json`;
    const upstream = await fetch(`${loopbackRuntimeUrl()}${path}`, {
      headers: createLocalRuntimeHeaders({ method: "GET", path, body: "" }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return json({ error: { code: "EVIDENCE_UNAVAILABLE", message: "本地批准服务返回了不安全的重定向" } }, { status: 502 });
    }
    if (!upstream.ok || !upstream.body) {
      return json({ error: { code: "EVIDENCE_UNAVAILABLE", message: "本地外部批准证据不可用" } }, { status: 502 });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `inline; filename="external-approval-${sequenceNumber}-manifest.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return problemResponse(error);
  }
}

function loopbackRuntimeUrl() {
  const url = new URL(process.env.DEVILUDO_LOCAL_RUNTIME_URL ?? "http://127.0.0.1:4311");
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
