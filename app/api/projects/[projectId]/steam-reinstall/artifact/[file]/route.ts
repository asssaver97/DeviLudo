import { json, problemResponse } from "@/lib/control-plane/http";
import { readLocalDelivery } from "@/lib/local-delivery/store";
import { authorizeLocalProjectAccess } from "@/lib/projects/project-read-access";
import { assertLoopbackTestRequest } from "@/lib/security/local-test-mode";
import { createLocalRuntimeHeaders } from "@/services/local-runtime/src/request-auth";

const BUILD_FILE = "DeviLudoLocalBeta.zip";

export async function GET(request: Request, context: { params: Promise<{ projectId: string; file: string }> }) {
  try {
    assertLoopbackTestRequest(request, "本地 Beta 安装包只在显式启用的 loopback 测试站可用");
    const { projectId, file } = await context.params;
    await authorizeLocalProjectAccess(projectId);
    if (file !== BUILD_FILE) return json({ error: { code: "NOT_FOUND", message: "本地 Beta 安装包不存在" } }, { status: 404 });
    const delivery = await readLocalDelivery(projectId);
    const reinstall = delivery.steamReinstall;
    const artifact = reinstall?.betaArtifact;
    if (!delivery.runId || !reinstall?.valid || reinstall.status !== "TESTS_PASSED"
      || reinstall.releaseGate !== "LOCAL_STEAM_REINSTALL_PASSED" || !artifact || artifact.fileName !== file) {
      return json({ error: { code: "BUILD_ARTIFACT_NOT_READY", message: "本地 Beta 完成干净回装与实际启动后才可下载" } }, { status: 409 });
    }
    const path = `/v1/steam-reinstalls/${encodeURIComponent(projectId)}/${encodeURIComponent(delivery.runId)}/artifacts/${BUILD_FILE}`;
    const upstream = await fetch(`${loopbackRuntimeUrl()}${path}`, {
      headers: createLocalRuntimeHeaders({ method: "GET", path, body: "" }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const digest = upstream.headers.get("x-deviludo-artifact-sha256");
    const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim();
    const contentLength = Number(upstream.headers.get("content-length"));
    if (upstream.status >= 300 && upstream.status < 400 || !upstream.ok || !upstream.body
      || digest !== artifact.sha256 || contentType !== artifact.contentType
      || !Number.isSafeInteger(contentLength) || contentLength !== artifact.sizeBytes) {
      return json({ error: { code: "BUILD_ARTIFACT_UNAVAILABLE", message: "本地 Beta 安装包与证据清单不一致" } }, { status: 502 });
    }
    return new Response(upstream.body, { status: 200, headers: {
      "content-type": artifact.contentType,
      "content-length": String(artifact.sizeBytes),
      "content-disposition": `attachment; filename="${BUILD_FILE}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-deviludo-artifact-sha256": artifact.sha256,
    } });
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
