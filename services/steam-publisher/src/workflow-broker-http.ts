import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import type { SteamTargetPlatform } from "./contracts";
import type {
  SteamDefaultBranchWorkflowReceipt,
  SteamPrivateBetaWorkflowReceipt,
} from "./workflow-handler";

const MAX_BODY_BYTES = 512 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[1-9][0-9]{0,19}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,99}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/;

interface SteamWorkflowRequestBinding {
  readonly schemaVersion: "deviludo.steam-workflow.v1";
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly runId: string;
}

export interface SteamPrivateBetaOperationRequest extends SteamWorkflowRequestBinding {
  readonly kind: "PRIVATE_BETA_UPLOAD";
  readonly mainCommitSha: string;
  readonly mainEvidenceBundleId: string;
  readonly mfaApprovalId: string;
  readonly targetMatrix: readonly SteamTargetPlatform[];
}

export interface SteamDefaultBranchOperationRequest extends SteamWorkflowRequestBinding {
  readonly kind: "DEFAULT_BRANCH_PUBLISH";
  readonly betaBuildId: string;
  readonly externalApprovalIds: readonly string[];
}

export type SteamWorkflowOperationRequest =
  | SteamPrivateBetaOperationRequest
  | SteamDefaultBranchOperationRequest;

interface SteamWorkflowOperationStatusBinding {
  readonly kind: SteamWorkflowOperationRequest["kind"];
  readonly operationId: string;
  readonly operationKey: string;
  readonly requestDigest: string;
}

export interface SteamWorkflowRunningStatus extends SteamWorkflowOperationStatusBinding {
  readonly status: "RUNNING";
  readonly receipt: null;
}

export interface SteamWorkflowFailedStatus extends SteamWorkflowOperationStatusBinding {
  readonly status: "FAILED";
  readonly errorCode: string;
  readonly terminal: boolean;
  readonly receipt: null;
}

export interface SteamWorkflowCompletedStatus extends SteamWorkflowOperationStatusBinding {
  readonly status: "COMPLETED";
  readonly receipt: SteamPrivateBetaWorkflowReceipt | SteamDefaultBranchWorkflowReceipt;
}

export type SteamWorkflowOperationStatus =
  | SteamWorkflowRunningStatus
  | SteamWorkflowFailedStatus
  | SteamWorkflowCompletedStatus;

export interface SteamWorkflowOperationLookup {
  readonly tenantId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly requestDigest: string;
}

export interface SteamWorkflowOperationService {
  submit(
    identity: EvidenceArchiveWorkloadIdentity,
    request: SteamWorkflowOperationRequest,
  ): Promise<SteamWorkflowOperationStatus>;
  get(
    identity: EvidenceArchiveWorkloadIdentity,
    lookup: SteamWorkflowOperationLookup,
  ): Promise<SteamWorkflowOperationStatus>;
  probe(): Promise<void>;
}

export interface SteamWorkflowBrokerHealthIdentity {
  readonly version: string;
  readonly binaryDigest: string;
}

export interface SteamWorkflowBrokerIngressRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}

export interface SteamWorkflowBrokerIngressResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createSteamWorkflowBrokerHandler(options: Readonly<{
  service: SteamWorkflowOperationService;
  allowedSpiffeIds: ReadonlySet<string>;
  healthIdentity: SteamWorkflowBrokerHealthIdentity;
  extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}>): (request: SteamWorkflowBrokerIngressRequest) => Promise<SteamWorkflowBrokerIngressResponse> {
  if (!options.allowedSpiffeIds.size) throw new Error("Steam workflow Broker workload allow-list is empty");
  const healthIdentity = validateHealthIdentity(options.healthIdentity);
  const extractIdentity = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request) => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extractIdentity(request.socket); }
    catch { return failure(401, "STEAM_WORKFLOW_BROKER_MTLS_IDENTITY_REQUIRED"); }
    if (!options.allowedSpiffeIds.has(identity.spiffeId)) {
      return failure(403, "STEAM_WORKFLOW_BROKER_WORKLOAD_FORBIDDEN");
    }
    if (request.method === "GET" && request.path === "/healthz") {
      if (request.rawBody) return failure(400, "STEAM_WORKFLOW_BROKER_REQUEST_INVALID");
      try { await options.service.probe(); }
      catch { return failure(503, "STEAM_WORKFLOW_BROKER_NOT_READY"); }
      return {
        status: 200,
        body: {
          schemaVersion: "deviludo.steam-workflow-broker-health.v1",
          status: "ok",
          service: "deviludo-steam-workflow-broker",
          ...healthIdentity,
        },
      };
    }
    if (request.method === "POST" && request.path === "/v1/steam-operations") {
      if (contentType(request.headers["content-type"]) !== "application/json") {
        return failure(415, "STEAM_WORKFLOW_BROKER_JSON_REQUIRED");
      }
      let body: SteamWorkflowOperationRequest;
      try {
        body = parseSteamWorkflowOperationRequest(request.rawBody);
        validateHeaders(request.headers, body.tenantId, body.operationKey, body.requestDigest);
      } catch {
        return failure(400, "STEAM_WORKFLOW_BROKER_REQUEST_INVALID");
      }
      try {
        const status = validateSteamWorkflowOperationStatus(await options.service.submit(identity, body), body);
        return statusResponse(status);
      } catch {
        return failure(409, "STEAM_WORKFLOW_BROKER_OPERATION_REJECTED");
      }
    }
    const operationId = statusOperationId(request.method, request.path);
    if (operationId) {
      if (request.rawBody) return failure(400, "STEAM_WORKFLOW_BROKER_REQUEST_INVALID");
      let lookup: SteamWorkflowOperationLookup;
      try {
        lookup = Object.freeze({
          tenantId: requiredHeader(request.headers, "x-deviludo-tenant-id", UUID),
          operationId,
          operationKey: requiredHeader(request.headers, "idempotency-key", /^workflow-job:[a-f0-9-]{36}$/),
          requestDigest: requiredHeader(request.headers, "x-deviludo-request-digest", SHA256),
        });
      } catch {
        return failure(400, "STEAM_WORKFLOW_BROKER_REQUEST_INVALID");
      }
      try {
        const status = validateSteamWorkflowOperationStatus(await options.service.get(identity, lookup), lookup);
        if (status.operationId !== lookup.operationId) throw new Error("operation identity drift");
        return statusResponse(status);
      } catch {
        return failure(404, "STEAM_WORKFLOW_BROKER_OPERATION_NOT_FOUND");
      }
    }
    return failure(404, "STEAM_WORKFLOW_BROKER_ROUTE_NOT_FOUND");
  };
}

export function createSteamWorkflowBrokerHttpsServer(options: Readonly<{
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  handler: (request: SteamWorkflowBrokerIngressRequest) => Promise<SteamWorkflowBrokerIngressResponse>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}>): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) {
    throw new Error("Steam workflow Broker TLS material is incomplete");
  }
  const maximum = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isInteger(maximum) || maximum < 32 * 1024 || maximum > MAX_BODY_BYTES) {
    throw new Error("Steam workflow Broker body limit is invalid");
  }
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 10 * 60_000) {
    throw new Error("Steam workflow Broker timeout is invalid");
  }
  const server = createServer({
    ...options.tls,
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => { void dispatch(request, response, options.handler, maximum); });
  server.requestTimeout = timeout;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

export function parseSteamWorkflowOperationRequest(value: unknown): SteamWorkflowOperationRequest {
  const body = typeof value === "string" ? parseJsonObject(value) : record(value);
  validateCommonRequest(body);
  if (body.kind === "PRIVATE_BETA_UPLOAD") {
    exactKeys(body, ["schemaVersion", "kind", "operationKey", "requestDigest", "tenantId", "projectId", "workflowId", "runId",
      "mainCommitSha", "mainEvidenceBundleId", "mfaApprovalId", "targetMatrix"]);
    if (typeof body.mainCommitSha !== "string" || !SHA1.test(body.mainCommitSha)
      || typeof body.mainEvidenceBundleId !== "string" || !UUID.test(body.mainEvidenceBundleId)
      || typeof body.mfaApprovalId !== "string" || !UUID.test(body.mfaApprovalId)) invalid();
    return Object.freeze({
      schemaVersion: "deviludo.steam-workflow.v1",
      kind: "PRIVATE_BETA_UPLOAD",
      operationKey: body.operationKey as string,
      requestDigest: body.requestDigest as string,
      tenantId: body.tenantId as string,
      projectId: body.projectId as string,
      workflowId: body.workflowId as string,
      runId: body.runId as string,
      mainCommitSha: body.mainCommitSha,
      mainEvidenceBundleId: body.mainEvidenceBundleId,
      mfaApprovalId: body.mfaApprovalId,
      targetMatrix: parseMatrix(body.targetMatrix),
    });
  }
  if (body.kind !== "DEFAULT_BRANCH_PUBLISH") invalid();
  exactKeys(body, ["schemaVersion", "kind", "operationKey", "requestDigest", "tenantId", "projectId", "workflowId", "runId",
    "betaBuildId", "externalApprovalIds"]);
  if (typeof body.betaBuildId !== "string" || !BUILD_ID.test(body.betaBuildId)) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.steam-workflow.v1",
    kind: "DEFAULT_BRANCH_PUBLISH",
    operationKey: body.operationKey as string,
    requestDigest: body.requestDigest as string,
    tenantId: body.tenantId as string,
    projectId: body.projectId as string,
    workflowId: body.workflowId as string,
    runId: body.runId as string,
    betaBuildId: body.betaBuildId,
    externalApprovalIds: parseIds(body.externalApprovalIds, 3),
  });
}

function validateCommonRequest(body: Record<string, unknown>): void {
  if (body.schemaVersion !== "deviludo.steam-workflow.v1"
    || typeof body.operationKey !== "string" || !/^workflow-job:[a-f0-9-]{36}$/.test(body.operationKey)
    || typeof body.requestDigest !== "string" || !SHA256.test(body.requestDigest)
    || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || typeof body.runId !== "string" || !UUID.test(body.runId)
    || typeof body.workflowId !== "string" || !SAFE_ID.test(body.workflowId)) invalid();
}

export function validateSteamWorkflowOperationStatus(
  value: unknown,
  expected: SteamWorkflowOperationRequest | Pick<SteamWorkflowOperationLookup, "operationKey" | "requestDigest">,
): SteamWorkflowOperationStatus {
  const body = record(value);
  const expectedKind = "kind" in expected ? expected.kind : undefined;
  if (body.operationKey !== expected.operationKey || body.requestDigest !== expected.requestDigest
    || expectedKind !== undefined && body.kind !== expectedKind
    || typeof body.kind !== "string" || !["PRIVATE_BETA_UPLOAD", "DEFAULT_BRANCH_PUBLISH"].includes(body.kind)
    || typeof body.operationId !== "string" || !SAFE_ID.test(body.operationId)) invalid();
  if (body.status === "RUNNING") {
    exactKeys(body, ["status", "kind", "operationId", "operationKey", "requestDigest", "receipt"]);
    if (body.receipt !== null) invalid();
    return Object.freeze({
      status: "RUNNING", kind: body.kind, operationId: body.operationId,
      operationKey: body.operationKey as string, requestDigest: body.requestDigest as string, receipt: null,
    }) as SteamWorkflowRunningStatus;
  }
  if (body.status === "FAILED") {
    exactKeys(body, ["status", "kind", "operationId", "operationKey", "requestDigest", "errorCode", "terminal", "receipt"]);
    if (typeof body.errorCode !== "string" || !ERROR_CODE.test(body.errorCode)
      || typeof body.terminal !== "boolean" || body.receipt !== null) invalid();
    return Object.freeze({
      status: "FAILED", kind: body.kind, operationId: body.operationId,
      operationKey: body.operationKey as string, requestDigest: body.requestDigest as string,
      errorCode: body.errorCode, terminal: body.terminal, receipt: null,
    }) as SteamWorkflowFailedStatus;
  }
  if (body.status !== "COMPLETED") invalid();
  exactKeys(body, ["status", "kind", "operationId", "operationKey", "requestDigest", "receipt"]);
  const receipt = body.kind === "PRIVATE_BETA_UPLOAD"
    ? parseUploadReceipt(body.receipt)
    : parsePublishReceipt(body.receipt);
  if ("kind" in expected) {
    if (expected.kind === "PRIVATE_BETA_UPLOAD") {
      const upload = receipt as SteamPrivateBetaWorkflowReceipt;
      if (upload.runId !== expected.runId || upload.mainCommitSha !== expected.mainCommitSha
        || upload.mainEvidenceBundleId !== expected.mainEvidenceBundleId || upload.mfaApprovalId !== expected.mfaApprovalId
        || JSON.stringify(upload.targetMatrix) !== JSON.stringify(expected.targetMatrix)) invalid();
    } else {
      const published = receipt as SteamDefaultBranchWorkflowReceipt;
      if (published.runId !== expected.runId || published.betaBuildId !== expected.betaBuildId
        || published.defaultBranchBuildId !== expected.betaBuildId
        || JSON.stringify(published.externalApprovalIds) !== JSON.stringify(expected.externalApprovalIds)) invalid();
    }
  }
  return Object.freeze({
    status: "COMPLETED", kind: body.kind, operationId: body.operationId,
    operationKey: body.operationKey as string, requestDigest: body.requestDigest as string, receipt,
  }) as SteamWorkflowCompletedStatus;
}

function parseUploadReceipt(value: unknown): SteamPrivateBetaWorkflowReceipt {
  const body = record(value);
  exactKeys(body, ["receiptId", "runId", "mainCommitSha", "mainEvidenceBundleId", "mfaApprovalId", "targetMatrix", "buildId"]);
  if (typeof body.receiptId !== "string" || !SAFE_ID.test(body.receiptId)
    || typeof body.runId !== "string" || !UUID.test(body.runId)
    || typeof body.mainCommitSha !== "string" || !SHA1.test(body.mainCommitSha)
    || typeof body.mainEvidenceBundleId !== "string" || !UUID.test(body.mainEvidenceBundleId)
    || typeof body.mfaApprovalId !== "string" || !UUID.test(body.mfaApprovalId)
    || typeof body.buildId !== "string" || !BUILD_ID.test(body.buildId)) invalid();
  return Object.freeze({
    receiptId: body.receiptId, runId: body.runId, mainCommitSha: body.mainCommitSha,
    mainEvidenceBundleId: body.mainEvidenceBundleId, mfaApprovalId: body.mfaApprovalId,
    targetMatrix: parseMatrix(body.targetMatrix), buildId: body.buildId,
  });
}

function parsePublishReceipt(value: unknown): SteamDefaultBranchWorkflowReceipt {
  const body = record(value);
  exactKeys(body, ["receiptId", "releaseId", "runId", "betaBuildId", "defaultBranchBuildId", "externalApprovalIds"]);
  if (typeof body.receiptId !== "string" || !SAFE_ID.test(body.receiptId)
    || typeof body.releaseId !== "string" || !SAFE_ID.test(body.releaseId)
    || typeof body.runId !== "string" || !UUID.test(body.runId)
    || typeof body.betaBuildId !== "string" || !BUILD_ID.test(body.betaBuildId)
    || typeof body.defaultBranchBuildId !== "string" || body.defaultBranchBuildId !== body.betaBuildId) invalid();
  return Object.freeze({
    receiptId: body.receiptId, releaseId: body.releaseId, runId: body.runId,
    betaBuildId: body.betaBuildId, defaultBranchBuildId: body.defaultBranchBuildId,
    externalApprovalIds: parseIds(body.externalApprovalIds, 3),
  });
}

function statusResponse(status: SteamWorkflowOperationStatus): SteamWorkflowBrokerIngressResponse {
  return {
    status: status.status === "RUNNING" ? 202 : 200,
    body: { schemaVersion: "deviludo.steam-workflow-operation-status.v1", ...status },
  };
}

function validateHeaders(
  headers: SteamWorkflowBrokerIngressRequest["headers"],
  tenantId: string,
  operationKey: string,
  requestDigest: string,
): void {
  if (requiredHeader(headers, "x-deviludo-tenant-id", UUID) !== tenantId
    || requiredHeader(headers, "idempotency-key", /^workflow-job:[a-f0-9-]{36}$/) !== operationKey
    || requiredHeader(headers, "x-deviludo-request-digest", SHA256) !== requestDigest) invalid();
}

function requiredHeader(
  headers: SteamWorkflowBrokerIngressRequest["headers"],
  name: string,
  pattern: RegExp,
): string {
  const value = headers[name];
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function statusOperationId(method: string, path: string): string | null {
  if (method !== "GET") return null;
  const match = /^\/v1\/steam-operations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/.exec(path);
  return match?.[1] ?? null;
}

function validateHealthIdentity(value: SteamWorkflowBrokerHealthIdentity): SteamWorkflowBrokerHealthIdentity {
  const body = record(value);
  exactKeys(body, ["version", "binaryDigest"]);
  if (typeof body.version !== "string" || !VERSION.test(body.version) || /(?:latest|stable|default)/i.test(body.version)
    || typeof body.binaryDigest !== "string" || !SHA256.test(body.binaryDigest)) invalid();
  return Object.freeze({ version: body.version, binaryDigest: body.binaryDigest });
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: SteamWorkflowBrokerIngressRequest) => Promise<SteamWorkflowBrokerIngressResponse>,
  maximum: number,
): Promise<void> {
  try {
    const rawBody = await readBody(request, maximum);
    send(response, await handler({
      method: request.method ?? "", path: request.url ?? "", headers: request.headers,
      socket: request.socket, rawBody,
    }));
  } catch (error) {
    send(response, error instanceof BodyTooLargeError
      ? failure(413, "STEAM_WORKFLOW_BROKER_REQUEST_TOO_LARGE")
      : failure(500, "STEAM_WORKFLOW_BROKER_UNAVAILABLE"));
  }
}

function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > maximum) { tooLarge = true; return; }
      chunks.push(value);
    });
    request.once("end", () => tooLarge ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("Steam workflow Broker request was aborted")));
  });
}

function send(response: ServerResponse, result: SteamWorkflowBrokerIngressResponse): void {
  const body = JSON.stringify(result.body);
  response.statusCode = result.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return record(parsed);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function parseMatrix(value: unknown): readonly SteamTargetPlatform[] {
  if (!Array.isArray(value) || !value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some((entry) => entry !== "windows" && entry !== "linux" && entry !== "macos")) invalid();
  return Object.freeze([...value]) as readonly SteamTargetPlatform[];
}

function parseIds(value: unknown, exactLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length !== exactLength || new Set(value).size !== value.length
    || value.some((entry) => typeof entry !== "string" || !SAFE_ID.test(entry))) invalid();
  return Object.freeze([...value]) as readonly string[];
}

function contentType(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null;
}

function failure(status: number, code: string): SteamWorkflowBrokerIngressResponse {
  return { status, body: { error: { code } } };
}

function invalid(): never { throw new Error("Steam workflow Broker contract is invalid"); }

class BodyTooLargeError extends Error {}
