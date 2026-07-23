import { json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";
import { authorizeLocalProjectAccess } from "@/lib/projects/project-read-access";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";

const allowedFiles = new Set(["manifest.json", "junit.xml", "godot.log"]);

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; file: string }> },
) {
  try {
    assertLoopbackTestRequest(request, "main 门禁证据只在显式启用的 loopback 测试站可用");
    const { projectId, file } = await context.params;
    await authorizeLocalProjectAccess(projectId);
    if (!allowedFiles.has(file)) return json({ error: { code: "NOT_FOUND", message: "main 门禁证据文件不存在" } }, { status: 404 });
    const delivery = await readLocalDelivery(projectId);
    if (!delivery.runId || !delivery.mainValidation) {
      return json({ error: { code: "EVIDENCE_NOT_READY", message: "main SHA 门禁证据尚未生成" } }, { status: 404 });
    }
    const path = `/v1/main-gates/${encodeURIComponent(projectId)}/${encodeURIComponent(delivery.runId)}/evidence/${file}`;
    const upstream = await fetch(`${loopbackRuntimeUrl()}${path}`, {
      headers: createLocalRuntimeHeaders({ method: "GET", path, body: "" }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return json({ error: { code: "EVIDENCE_UNAVAILABLE", message: "main 门禁服务返回了不安全的重定向" } }, { status: 502 });
    }
    if (!upstream.ok || !upstream.body) {
      return json({ error: { code: "EVIDENCE_UNAVAILABLE", message: "main SHA 门禁证据文件不可用" } }, { status: 502 });
    }
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
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("DEVILUDO_LOCAL_RUNTIME_URL must be a plain loopback HTTP origin");
  }
  return url.origin;
}
