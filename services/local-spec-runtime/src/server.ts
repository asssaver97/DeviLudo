import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { parseLocalSmokeCleanupRequest } from "../../../lib/local-smoke-project";
import { DeterministicLocalSpecModel } from "../../spec-dialogue/src/model";
import { SpecDialogueConflict, SpecDialogueService } from "../../spec-dialogue/src/service";
import { InMemorySpecDialogueStore } from "../../spec-dialogue/src/store";
import {
  LocalSpecRuntimeAuthenticationError,
  LocalSpecRuntimeRequestVerifier,
  localSpecRuntimeKeyFromEnvironment,
} from "./request-auth";
import {
  LocalSpecRuntimePersistenceError,
  LocalSpecRuntimeStateFile,
  type LocalSpecRuntimeState,
  type PersistedFeedbackClaim,
} from "./persistent-state";

const HOST = "127.0.0.1";
const PORT = parsePort(process.env.DEVILUDO_LOCAL_SPEC_RUNTIME_PORT ?? "4313");
const BODY_LIMIT = 16 * 1024;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type FeedbackClaim = PersistedFeedbackClaim;
type LocalSpecRuntime = Readonly<{
  service: SpecDialogueService;
  store: InMemorySpecDialogueStore;
  currentConversationIds: Map<string, string>;
  feedbackClaims: Map<string, FeedbackClaim>;
  persistence: LocalSpecRuntimeStateFile | null;
}>;

export function createLocalSpecRuntimeServer(
  options: Readonly<{ authenticationKey?: Uint8Array; stateFile?: string }> = {},
) {
  const requestVerifier = new LocalSpecRuntimeRequestVerifier(
    options.authenticationKey ?? localSpecRuntimeKeyFromEnvironment(),
  );
  const persistence = options.stateFile ? new LocalSpecRuntimeStateFile(options.stateFile) : null;
  const persisted = persistence?.load() ?? null;
  const store = new InMemorySpecDialogueStore(persisted?.store);
  const runtime: LocalSpecRuntime = {
    store,
    service: new SpecDialogueService(store, new DeterministicLocalSpecModel()),
    currentConversationIds: new Map(persisted?.currentConversationIds ?? []),
    feedbackClaims: new Map(persisted?.feedbackClaims ?? []),
    persistence,
  };
  return createServer(async (request, response) => {
    secure(response);
    try {
      await dispatch(request, response, requestVerifier, runtime);
    } catch (error) {
      if (error instanceof LocalSpecRuntimeAuthenticationError) return json(response, 403, { error: { code: "LOCAL_SPEC_RUNTIME_AUTH_REQUIRED", message: "Authenticated local specification runtime request is required" } });
      if (error instanceof BodyLimitError) return json(response, 413, { error: { code: "LOCAL_SPEC_REQUEST_TOO_LARGE", message: "Local specification message is too large" } });
      if (error instanceof SpecDialogueConflict) return json(response, 409, { error: { code: error.code, message: "Specification revision changed; refresh before retrying" } });
      if (error instanceof LocalSpecRuntimePersistenceError) return json(response, 503, { error: { code: error.code, message: "Local specification persistence is temporarily unavailable; retry the same operation" } });
      return json(response, 400, { error: { code: "INVALID_LOCAL_SPEC_REQUEST", message: "Local specification request is invalid" } });
    }
  });
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  requestVerifier: LocalSpecRuntimeRequestVerifier,
  runtime: LocalSpecRuntime,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}`);
  if (request.method === "GET" && url.pathname === "/health") {
    await runtime.service.probe();
    await runtime.persistence?.probe();
    return json(response, 200, { status: "ok", service: "deviludo-local-spec-runtime", mode: "deterministic-loopback" });
  }
  if (url.search) return json(response, 404, { error: { code: "NOT_FOUND", message: "Local specification runtime route not found" } });
  if (request.method === "POST" && url.pathname === "/v1/smoke-cleanup") {
    if (contentType(request.headers["content-type"]) !== "application/json") {
      return json(response, 415, { error: { code: "JSON_REQUIRED", message: "Local smoke cleanup requires JSON" } });
    }
    const rawBody = await readBody(request);
    requestVerifier.verify({ method: "POST", path: url.pathname, body: rawBody, headers: request.headers });
    const projectIds = parseLocalSmokeCleanupRequest(JSON.parse(rawBody));
    const store = runtime.store.deleteProjects(projectIds);
    let conversations = 0;
    for (const projectId of projectIds) {
      if (runtime.currentConversationIds.delete(projectId)) conversations += 1;
    }
    let feedbackClaims = 0;
    for (const [operationKey, claim] of runtime.feedbackClaims) {
      if (projectIds.some((projectId) => claim.conversationId.startsWith(`local:${projectId}:feedback:`))) {
        runtime.feedbackClaims.delete(operationKey);
        feedbackClaims += 1;
      }
    }
    await persist(runtime);
    return json(response, 200, { data: { projectIds, store, conversations, feedbackClaims } });
  }
  const match = /^\/v1\/projects\/([^/]+)\/(conversation|feedback|spec-approval)$/.exec(url.pathname);
  if (!match) return json(response, 404, { error: { code: "NOT_FOUND", message: "Local specification runtime route not found" } });
  const projectId = decodeURIComponent(match[1]!);
  const operation = match[2]!;
  if (!PROJECT.test(projectId)) throw new Error("project");
  const conversationId = runtime.currentConversationIds.get(projectId) ?? `local:${projectId}`;
  const binding = { tenantId: "tenant-local", projectId, conversationId };
  if (request.method === "GET" && operation === "conversation") {
    requestVerifier.verify({ method: "GET", path: url.pathname, body: "", headers: request.headers });
    return json(response, 200, { data: await runtime.service.snapshot(binding) });
  }
  if (request.method !== "POST" || contentType(request.headers["content-type"]) !== "application/json") {
    return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Local specification route requires JSON POST" } });
  }
  const rawBody = await readBody(request);
  requestVerifier.verify({ method: "POST", path: url.pathname, body: rawBody, headers: request.headers });
  const idempotency = header(request, "idempotency-key");
  if (!idempotency || !IDEMPOTENCY.test(idempotency)) throw new Error("idempotency");
  const body = object(JSON.parse(rawBody));
  const operationKey = createHash("sha256").update(`${projectId}\0${operation}\0${idempotency}`).digest("hex");
  if (operation === "spec-approval") {
    if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["expectedRevision", "specRevisionId", "testPlanRevisionId"])) throw new Error("shape");
    const receipt = await runtime.service.approve({ ...binding, actorId: "local-user", operationKey, ...body });
    await persist(runtime);
    return json(response, 201, { data: receipt });
  }
  if (operation === "feedback") {
    if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["feedback"]) || typeof body.feedback !== "string") throw new Error("shape");
    let claim = runtime.feedbackClaims.get(operationKey);
    if (!claim) {
      const source = await runtime.service.snapshot(binding);
      if (!source || source.state !== "APPROVED" || !source.result) throw new Error("feedback ancestor");
      const nextConversationId = `local:${projectId}:feedback:${operationKey.slice(0, 32)}`;
      await runtime.store.forkApproved({ ...binding, nextConversationId });
      claim = Object.freeze({ conversationId: nextConversationId, expectedRevision: source.revision });
      runtime.feedbackClaims.set(operationKey, claim);
      runtime.currentConversationIds.set(projectId, nextConversationId);
    }
    const snapshot = await runtime.service.send({
      tenantId: "tenant-local", projectId, conversationId: claim.conversationId,
      actorId: "local-user", operationKey, expectedRevision: claim.expectedRevision, message: body.feedback,
    });
    runtime.currentConversationIds.set(projectId, claim.conversationId);
    await persist(runtime);
    return json(response, 201, { data: snapshot });
  }
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["expectedRevision", "message"])) throw new Error("shape");
  const snapshot = await runtime.service.send({ ...binding, actorId: "local-user", operationKey, expectedRevision: body.expectedRevision, message: body.message });
  runtime.currentConversationIds.set(projectId, conversationId);
  await persist(runtime);
  return json(response, 201, { data: snapshot });
}

async function persist(runtime: LocalSpecRuntime): Promise<void> {
  if (!runtime.persistence) return;
  const state: LocalSpecRuntimeState = Object.freeze({
    schema: "deviludo.local-spec-state.v1",
    store: runtime.store.exportState(),
    currentConversationIds: Object.freeze([...runtime.currentConversationIds.entries()].map((entry) => Object.freeze(entry))),
    feedbackClaims: Object.freeze([...runtime.feedbackClaims.entries()].map(([operationKey, claim]) => Object.freeze([
      operationKey,
      Object.freeze({ ...claim }),
    ] as const))),
  });
  await runtime.persistence.save(state);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes <= BODY_LIMIT) chunks.push(value);
    });
    request.once("end", () => bytes > BODY_LIMIT ? reject(new BodyLimitError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("aborted")));
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
  return value as Record<string, unknown>;
}
function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}
function contentType(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null;
}
function secure(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
}
function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(encoded));
  response.end(encoded);
}
function parsePort(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535 || String(value) !== raw) throw new Error("DEVILUDO_LOCAL_SPEC_RUNTIME_PORT is invalid");
  return value;
}
class BodyLimitError extends Error {}

export async function runLocalSpecRuntime(): Promise<void> {
  const stateFile = process.env.DEVILUDO_LOCAL_SPEC_STATE_FILE;
  if (!stateFile) throw new Error("DEVILUDO_LOCAL_SPEC_STATE_FILE is required");
  const server = createLocalSpecRuntimeServer({ stateFile });
  server.listen(PORT, HOST, () => console.log(`[local-spec-runtime] READY http://${HOST}:${PORT}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runLocalSpecRuntime();
