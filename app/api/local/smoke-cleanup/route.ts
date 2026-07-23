import { json } from "@/lib/control-plane/http";
import { cleanupLocalSmokeDeliveries } from "@/lib/local-delivery/store";
import { isEphemeralSmokeProjectId, parseLocalSmokeCleanupRequest } from "@/lib/local-smoke-project";
import { cleanupLocalSmokeProjects } from "@/lib/projects/local-project-catalog";
import {
  LocalSmokeMaintenanceAuthenticationError,
  LocalSmokeMaintenanceRequestVerifier,
  localSmokeMaintenanceKeyFromEnvironment,
} from "@/lib/security/local-smoke-maintenance-auth";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const PATH = "/api/local/smoke-cleanup";
const BODY_LIMIT = 16 * 1024;
let verifier: LocalSmokeMaintenanceRequestVerifier | null = null;
let verifierKey = "";

export async function POST(request: Request): Promise<Response> {
  if (!isLoopbackTestRequest(request)) {
    return json({ error: { code: "NOT_FOUND", message: "Route not found" } }, { status: 404 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: { code: "JSON_REQUIRED", message: "Local smoke cleanup requires JSON" } }, { status: 415 });
  }
  let rawBody: Uint8Array;
  try { rawBody = await boundedBody(request); }
  catch { return json({ error: { code: "LOCAL_SMOKE_REQUEST_TOO_LARGE", message: "Local smoke cleanup request is too large" } }, { status: 413 }); }
  try {
    maintenanceVerifier().verify({
      method: "POST",
      path: PATH,
      body: rawBody,
      headers: Object.fromEntries(request.headers.entries()),
    });
  } catch (error) {
    const configured = error instanceof LocalSmokeMaintenanceAuthenticationError;
    return json({ error: {
      code: configured ? "LOCAL_SMOKE_AUTH_REQUIRED" : "LOCAL_SMOKE_MAINTENANCE_UNAVAILABLE",
      message: configured ? "Authenticated local smoke maintenance request is required" : "Local smoke maintenance is unavailable",
    } }, { status: configured ? 403 : 503 });
  }
  let projectIds: readonly string[];
  try {
    projectIds = parseLocalSmokeCleanupRequest(JSON.parse(new TextDecoder().decode(rawBody)));
  } catch {
    return json({ error: { code: "INVALID_LOCAL_SMOKE_CLEANUP", message: "Local smoke cleanup request is invalid" } }, { status: 400 });
  }
  try {
    const delivery = await cleanupLocalSmokeDeliveries(projectIds);
    const ephemeral = projectIds.filter(isEphemeralSmokeProjectId);
    const catalog = ephemeral.length
      ? await cleanupLocalSmokeProjects(ephemeral)
      : Object.freeze({ projects: 0, commands: 0 });
    return json({ data: { projectIds, delivery, catalog } });
  } catch {
    return json({ error: { code: "LOCAL_SMOKE_CLEANUP_FAILED", message: "Local smoke state cleanup failed" } }, { status: 503 });
  }
}

function maintenanceVerifier(): LocalSmokeMaintenanceRequestVerifier {
  const encoded = process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY?.trim() ?? "";
  if (!verifier || verifierKey !== encoded) {
    verifier = new LocalSmokeMaintenanceRequestVerifier(localSmokeMaintenanceKeyFromEnvironment());
    verifierKey = encoded;
  }
  return verifier;
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new Error("body");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > BODY_LIMIT) {
      await reader.cancel();
      throw new Error("body");
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
