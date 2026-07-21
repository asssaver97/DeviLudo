import { json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";

const RUNTIME_URL = loopbackRuntimeUrl();
const allowedFiles = new Set(["manifest.json", "junit.xml", "godot.log"]);

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; file: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "证据文件只在显式启用的 loopback 测试站可用");
    const { projectId, file } = await context.params;
    if (!allowedFiles.has(file)) return json({ error: { code: "NOT_FOUND", message: "证据文件不存在" } }, { status: 404 });
    const delivery = await readLocalDelivery(projectId);
    if (!delivery.runId || !delivery.localValidation) {
      return json({ error: { code: "EVIDENCE_NOT_READY", message: "本机证据尚未生成" } }, { status: 404 });
    }
    const path = `/v1/runs/${encodeURIComponent(projectId)}/${encodeURIComponent(delivery.runId)}/evidence/${file}`;
    const upstream = await fetch(`${RUNTIME_URL}${path}`, {
      headers: createLocalRuntimeHeaders({ method: "GET", path, body: "" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) return json({ error: { code: "EVIDENCE_UNAVAILABLE", message: "本机证据文件不可用" } }, { status: 502 });
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "content-disposition": `inline; filename="${file}"`,
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
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) {
    throw new Error("DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
